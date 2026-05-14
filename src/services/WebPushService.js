/**
 * WebPushService — sends Web Push notifications without any third-party library.
 *
 * Implements:
 *   • VAPID authentication (RFC 8292) — ES256 JWT signed with the application
 *     server's ECDSA P-256 private key.
 *   • Payload encryption (RFC 8291 / RFC 8188 aes128gcm content-encoding) —
 *     ECDH key agreement, HKDF key derivation, AES-128-GCM encryption, all via
 *     the standard Web Crypto API (crypto.subtle), available in Bun natively.
 *
 * Required env vars (set via `bun scripts/generate-vapid.js`):
 *   VAPID_PUBLIC_KEY   base64url-encoded raw P-256 public key (65 bytes)
 *   VAPID_PRIVATE_KEY  base64url-encoded P-256 private scalar d (32 bytes)
 *   VAPID_SUBJECT      contact URI, e.g. mailto:admin@example.com
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

function b64url_encode(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function b64url_decode(str) {
  const padded = str + '==='.slice((str.length + 3) % 4)
  return Uint8Array.from(atob(padded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
}

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) { out.set(a, off); off += a.length }
  return out
}

// ── Service ──────────────────────────────────────────────────────────────────

export class WebPushService {
  #publicKey   // base64url string — raw uncompressed P-256 (65 bytes)
  #privateKey  // base64url string — P-256 scalar d (32 bytes)
  #subject     // mailto: or https: contact URI
  #pushRepo

  constructor({ vapidPublicKey, vapidPrivateKey, vapidSubject, pushRepo }) {
    this.#publicKey  = vapidPublicKey  ?? null
    this.#privateKey = vapidPrivateKey ?? null
    this.#subject    = vapidSubject    ?? null
    this.#pushRepo   = pushRepo
  }

  isConfigured() {
    return !!(this.#publicKey && this.#privateKey && this.#subject)
  }

  /** Send a push notification to every registered subscription for userId. */
  async sendToUser({ userId, title, body, url, channelId }) {
    if (!this.isConfigured()) return
    const subs = this.#pushRepo.getSubscriptionsForUser(userId)
    if (subs.length === 0) return
    await Promise.allSettled(
      subs.map(sub => this.#sendOne(sub, { title, body, url, channel_id: channelId }))
    )
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  async #sendOne(sub, payload) {
    let encrypted
    try {
      encrypted = await this.#encrypt(sub, JSON.stringify(payload))
    } catch (err) {
      // Encryption failure is a bug — re-throw so the caller can log it
      throw new Error(`WebPush encrypt failed: ${err?.message}`)
    }

    const audience = new URL(sub.endpoint).origin
    const jwt = await this.#buildJwt(audience)

    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization:      `vapid t=${jwt},k=${this.#publicKey}`,
        'Content-Type':     'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL:                '86400',
      },
      body: encrypted,
    })

    if (res.status === 404 || res.status === 410) {
      // Subscription has expired or was removed — clean up
      this.#pushRepo.removeSubscription(sub.endpoint)
    }
  }

  /**
   * Build an ES256 VAPID JWT for the given push service origin.
   *
   * JWT header: { typ: "JWT", alg: "ES256" }
   * JWT claims: { aud, exp, sub }
   * Signature:  ECDSA P-256 / SHA-256 (IEEE P1363 format — raw r||s, 64 bytes)
   */
  async #buildJwt(audience) {
    const enc = new TextEncoder()

    // Reconstruct JWK from raw public key bytes + private scalar d
    const pub = b64url_decode(this.#publicKey) // 65-byte uncompressed: 0x04 || x(32) || y(32)
    const jwk = {
      kty: 'EC', crv: 'P-256',
      x:   b64url_encode(pub.slice(1, 33)),
      y:   b64url_encode(pub.slice(33, 65)),
      d:   this.#privateKey,
      ext: true,
    }
    const sigKey = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['sign']
    )

    const header  = b64url_encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
    const claims  = b64url_encode(enc.encode(JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 43_200, // 12 h
      sub: this.#subject,
    })))

    const sigInput = enc.encode(`${header}.${claims}`)
    const sigRaw   = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sigKey, sigInput)
    ) // 64 bytes: r(32) || s(32) in IEEE P1363 format — correct for JWT ES256

    return `${header}.${claims}.${b64url_encode(sigRaw)}`
  }

  /**
   * Encrypt a plaintext string for delivery to a push subscription.
   *
   * Follows RFC 8291 (Message Encryption for Web Push) which layers on top of
   * RFC 8188 (Encrypted Content-Encoding for HTTP, aes128gcm variant).
   *
   * Key derivation chain:
   *   ecdh_secret = ECDH(as_private_ephemeral, ua_public)
   *   IKM         = HKDF(salt=auth, IKM=ecdh_secret, info="WebPush: info\0"||ua_pub||as_pub, 32)
   *   CEK         = HKDF(salt=random_salt, IKM=IKM, info="Content-Encoding: aes128gcm\0", 16)
   *   NONCE       = HKDF(salt=random_salt, IKM=IKM, info="Content-Encoding: nonce\0",      12)
   *
   * Ciphertext format (RFC 8188):
   *   random_salt(16) || rs(4 BE) || keyid_len(1) || as_pub(65) || AES-128-GCM(padded_plaintext)
   */
  async #encrypt(sub, plaintext) {
    const enc = new TextEncoder()

    // ── Subscription keys ────────────────────────────────────────────────────
    const ua_public   = b64url_decode(sub.p256dh)  // 65-byte uncompressed P-256 point
    const auth_secret = b64url_decode(sub.auth)    // 16 bytes

    // ── Ephemeral application-server key pair ────────────────────────────────
    const as_kp = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
    )
    const as_public_raw = new Uint8Array(await crypto.subtle.exportKey('raw', as_kp.publicKey)) // 65 bytes

    // ── ECDH shared secret ───────────────────────────────────────────────────
    const ua_key = await crypto.subtle.importKey(
      'raw', ua_public, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    )
    const ecdh_secret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'ECDH', public: ua_key }, as_kp.privateKey, 256)
    )

    // ── RFC 8291: derive IKM ─────────────────────────────────────────────────
    // key_info = "WebPush: info\0" || ua_public || as_public
    const key_info = concat([enc.encode('WebPush: info\0'), ua_public, as_public_raw])
    const ecdh_key = await crypto.subtle.importKey('raw', ecdh_secret, 'HKDF', false, ['deriveBits'])
    const ikm = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: auth_secret, info: key_info },
      ecdh_key, 256
    ))

    // ── RFC 8188 aes128gcm: derive CEK and NONCE ─────────────────────────────
    const random_salt = crypto.getRandomValues(new Uint8Array(16))
    const ikm_key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    const [cek_bits, nonce_bits] = await Promise.all([
      crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: random_salt, info: enc.encode('Content-Encoding: aes128gcm\0') },
        ikm_key, 128
      ),
      crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: random_salt, info: enc.encode('Content-Encoding: nonce\0') },
        ikm_key, 96
      ),
    ])
    const cek   = new Uint8Array(cek_bits)
    const nonce = new Uint8Array(nonce_bits)

    // ── Encrypt with AES-128-GCM ─────────────────────────────────────────────
    // Pad with delimiter byte 0x02 (marks the last record in aes128gcm)
    const padded = concat([enc.encode(plaintext), new Uint8Array([2])])
    const aes_key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes_key, padded)
    )

    // ── RFC 8188 content-encoding header ─────────────────────────────────────
    // salt(16) || rs(4 big-endian) || keyid_len(1) || keyid(65)
    const hdr = new Uint8Array(16 + 4 + 1 + as_public_raw.length)
    hdr.set(random_salt, 0)
    new DataView(hdr.buffer).setUint32(16, 4096, false) // record size = 4096
    hdr[20] = as_public_raw.length                      // keyid length = 65
    hdr.set(as_public_raw, 21)

    return concat([hdr, ciphertext])
  }
}
