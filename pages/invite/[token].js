import { p } from '../../src/config.js'

/**
 * /invite/:token — redirect to the signup tab on /login with token pre-filled.
 */
export async function GET(req) {
  const url = new URL(req.url)
  const token = url.pathname.split('/').pop()
  return Response.redirect(p(`/login?invite=${encodeURIComponent(token)}`), 302)
}
