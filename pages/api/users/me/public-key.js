/**
 * PUT /api/users/me/public-key
 *
 * Register or replace the caller's ECDH public key (JWK format).
 * Called on app init by CryptoManager after key generation or reload.
 *
 * Body: { public_key_jwk: string }
 */
import { sessionFromRequest, secretModeService } from '../../../../src/context.js'

export async function PUT(req) {
  const session = sessionFromRequest(req)
  if (!session?.user) return new Response('Unauthorized', { status: 401 })

  let body
  try {
    body = await req.json()
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const { public_key_jwk } = body ?? {}
  if (!public_key_jwk) return new Response('public_key_jwk required', { status: 400 })

  try {
    secretModeService.setPublicKey({ userId: session.user.user_id, publicKeyJwk: public_key_jwk })
  } catch (err) {
    return new Response(err.message ?? 'Bad Request', { status: 400 })
  }

  return new Response(null, { status: 204 })
}
