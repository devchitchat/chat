/**
 * /invite/:token — redirect to the signup tab on /login with token pre-filled.
 */
export async function GET(req) {
  const url = new URL(req.url)
  const token = url.pathname.split('/').pop()
  return Response.redirect(new URL(`/login?invite=${encodeURIComponent(token)}`, req.url), 302)
}
