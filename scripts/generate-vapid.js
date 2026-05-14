/**
 * Generate a VAPID key pair for Web Push.
 * Run once: bun scripts/generate-vapid.js
 * Copy the output into your .env file.
 */

function b64url(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

const keypair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
)

const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keypair.publicKey))
const privateJwk = await crypto.subtle.exportKey('jwk', keypair.privateKey)

console.log('# Add these to your .env file:\n')
console.log(`VAPID_PUBLIC_KEY=${b64url(publicRaw)}`)
console.log(`VAPID_PRIVATE_KEY=${privateJwk.d}`)
console.log(`VAPID_SUBJECT=mailto:admin@your-domain.com`)
