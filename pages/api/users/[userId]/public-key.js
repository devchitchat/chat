/**
 * GET /api/users/:userId/public-key
 *
 * Returns the ECDH public key for a given user (JWK format).
 * Required before sending the first secret message to that user.
 *
 * Returns 404 if the user has not yet registered a public key
 * (they haven't opened the app since the secret-messaging feature shipped).
 */
import { sessionFromRequest, botUserFromRequest, secretModeService } from '../../../../src/context.js'

export async function GET(req) {
  const session = sessionFromRequest(req)
  const user    = session?.user ?? await botUserFromRequest(req)
  if (!user) return new Response('Unauthorized', { status: 401 })

  const userId = new URL(req.url).pathname.split('/').filter(Boolean).at(-2)
  if (!userId) return new Response('Not Found', { status: 404 })

  const row = secretModeService.getPublicKey({ userId })
  if (!row) return new Response('Not Found', { status: 404 })

  return Response.json({ user_id: row.user_id, public_key_jwk: row.public_key_jwk })
}
