import { requireAdminSession } from '../../src/adminAuth.js'
import { p } from '../../src/config.js'

export function GET(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session
  return Response.redirect(new URL(p('/admin/invites'), req.url), 302)
}
