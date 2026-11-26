/**
 * CryptoManager.js — WebCrypto-based E2E encryption for secret DMs.
 *
 * Key exchange: ECDH with P-256.
 * Message encryption: AES-GCM 256-bit with a random 96-bit IV per message.
 *
 * Private key is stored as a non-extractable CryptoKey in IndexedDB.
 * Shared AES-GCM keys are derived on first use with each peer and cached
 * in memory for the session duration.
 *
 * Usage:
 *   const cm = new CryptoManager()
 *   await cm.init()
 *   const jwk = await cm.getPublicKeyJwk()
 *   const { iv, ciphertext } = await cm.encrypt('hello', recipientJwk)
 *   const plain = await cm.decrypt(iv, ciphertext, senderJwk)
 */

const DB_NAME   = 'devchitchat-crypto'
const DB_VERSION = 1
const STORE_NAME = 'keys'
const KEY_ID     = 'ecdh-keypair'

export class CryptoManager {
  #keyPair       = null  // { publicKey: CryptoKey, privateKey: CryptoKey }
  #sharedSecrets = new Map()  // userPublicKeyJwk → CryptoKey (AES-GCM)
  #db            = null

  /**
   * Load an existing key pair from IndexedDB, or generate and store a new one.
   * Must be called before any other method.
   */
  async init() {
    this.#db = await _openDb()
    const stored = await _idbGet(this.#db, KEY_ID)
    if (stored?.publicKey && stored?.privateKey) {
      this.#keyPair = stored
    } else {
      this.#keyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,  // non-extractable private key
        ['deriveKey']
      )
      await _idbPut(this.#db, KEY_ID, this.#keyPair)
    }
  }

  /**
   * Export the local public key as a JWK string (suitable for server storage).
   * @returns {Promise<string>}
   */
  async getPublicKeyJwk() {
    _assertInit(this.#keyPair)
    const jwk = await crypto.subtle.exportKey('jwk', this.#keyPair.publicKey)
    return JSON.stringify(jwk)
  }

  /**
   * Encrypt plaintext for a recipient identified by their public key JWK.
   * @param {string} plaintext
   * @param {string} recipientPublicKeyJwk — JSON string
   * @returns {Promise<{ iv: string, ciphertext: string }>} base64-encoded
   */
  async encrypt(plaintext, recipientPublicKeyJwk) {
    _assertInit(this.#keyPair)
    const aesKey = await this.#getSharedKey(recipientPublicKeyJwk)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encoded = new TextEncoder().encode(plaintext)
    const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded)
    return {
      iv:         _toBase64(iv),
      ciphertext: _toBase64(new Uint8Array(ciphertextBuf)),
    }
  }

  /**
   * Decrypt a message received from a sender.
   * @param {string} ivBase64
   * @param {string} ciphertextBase64
   * @param {string} senderPublicKeyJwk — JSON string
   * @returns {Promise<string>} plaintext
   */
  async decrypt(ivBase64, ciphertextBase64, senderPublicKeyJwk) {
    _assertInit(this.#keyPair)
    const aesKey = await this.#getSharedKey(senderPublicKeyJwk)
    const iv         = _fromBase64(ivBase64)
    const ciphertext = _fromBase64(ciphertextBase64)
    const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext)
    return new TextDecoder().decode(plaintextBuf)
  }

  // ── Private ────────────────────────────────────────────────────────────────

  async #getSharedKey(peerPublicKeyJwk) {
    if (this.#sharedSecrets.has(peerPublicKeyJwk)) {
      return this.#sharedSecrets.get(peerPublicKeyJwk)
    }
    const peerPublicKey = await crypto.subtle.importKey(
      'jwk',
      JSON.parse(peerPublicKeyJwk),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    )
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPublicKey },
      this.#keyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
    this.#sharedSecrets.set(peerPublicKeyJwk, aesKey)
    return aesKey
  }
}

// ── IndexedDB helpers ──────────────────────────────────────────────────────

function _openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

function _idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror   = () => reject(req.error)
  })
}

function _idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite')
    const req = tx.objectStore(STORE_NAME).put(value, key)
    req.onsuccess = () => resolve()
    req.onerror   = () => reject(req.error)
  })
}

// ── Utility ────────────────────────────────────────────────────────────────

function _toBase64(buf) {
  return btoa(String.fromCharCode(...buf))
}

function _fromBase64(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0))
}

function _assertInit(keyPair) {
  if (!keyPair) throw new Error('CryptoManager not initialised — call init() first')
}
