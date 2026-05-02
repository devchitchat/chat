import { requireAdminSession } from '../../src/adminAuth.js'

export function GET(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session
  return Response.redirect(new URL('/admin/invites', req.url), 302)
}
