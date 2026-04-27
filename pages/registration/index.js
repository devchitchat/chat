import { auth, sessionFromRequest, sessionCookie } from '../../src/context.js'

export async function GET(req) {
  const session = sessionFromRequest(req)
  if (session) return Response.redirect(new URL('/', req.url), 302)

  const url = new URL(req.url)
  const inviteToken = url.searchParams.get('invite') ?? ''
  return { error: null, invite_token: inviteToken }
}

export async function POST(req) {
  const form = await req.formData()
  try {
    const inviteToken = form.get('invite_token')?.trim()
    const handle = form.get('handle')?.trim()
    const display_name = form.get('display_name')?.trim() || handle
    const password = form.get('password')
    const result = await auth.redeemInvite({ inviteToken, profile: { handle, display_name }, password })
    return new Response(null, {
        status: 302,
        headers: {
            Location: '/',
            'Set-Cookie': sessionCookie(result.sessionToken),
        }
    })
  } catch (err) {
    const invite_token = form.get('invite_token') ?? ''
    return {
      error: err.message ?? 'Something went wrong',
      invite_token,
    }
  }
}
