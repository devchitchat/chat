/**
 * GET /api/user/:userId — fetch basic profile info for a user.
 *
 * Accessible via bot Bearer token or human session cookie.
 * Returns only non-sensitive fields; notably includes roles so
 * bots can verify admin status before acting on behalf of a user.
 */
import { sessionFromRequest, botUserFromRequest, auth } from '../../../src/context.js'

async function _resolveCallerUserId(req) {
  const session = sessionFromRequest(req)
  if (session?.user) return session.user.user_id
  const bot = await botUserFromRequest(req)
  if (bot?.user_id) return bot.user_id
  return null
}

export async function GET(req) {
  const callerId = await _resolveCallerUserId(req)
  if (!callerId) return new Response('Unauthorized', { status: 401 })

  const userId = new URL(req.url).pathname.split('/').filter(Boolean).pop()
  const user   = auth.getUser(userId)
  if (!user) return new Response('Not Found', { status: 404 })

  return Response.json({
    user_id:         user.user_id,
    handle:          user.handle,
    display_name:    user.display_name,
    roles:           user.roles ?? [],
    avatar_initials: user.avatar_initials ?? null,
    avatar_color:    user.avatar_color    ?? null,
    avatar_url:      user.avatar_url      ?? null,
  })
}
