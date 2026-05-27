/**
 * adminAuth — shared guard for admin HTTP pages.
 *
 * Usage in a page handler:
 *   import { requireAdminSession } from '../../src/adminAuth.js'
 *   const session = requireAdminSession(req)
 *   if (session instanceof Response) return session  // redirect to login
 */
import { sessionFromRequest, logger } from './context.js'

/**
 * Returns the validated admin session, or a redirect Response if the user
 * is not authenticated or lacks the admin role.
 */
export function requireAdminSession(req) {
  const session = sessionFromRequest(req)
  if (!session) {
    return Response.redirect(new URL('/login', req.url), 302)
  }
  if (!session.user.roles.includes('admin')) {
    logger?.warn('admin.access_denied', { userId: session.user.user_id, url: req.url })
    return new Response('Forbidden', { status: 403 })
  }
  return session
}
