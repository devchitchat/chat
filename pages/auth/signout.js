import { auth, sessionFromRequest, sessionCookie } from '../../src/context.js'

export async function POST(req) {
  const session = sessionFromRequest(req)
  if (session) auth.revokeSession(session.session_id)
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/login',
      'Set-Cookie': sessionCookie(null, { clear: true }),
    }
  })
}
