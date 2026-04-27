import { auth, sessionFromRequest, sessionCookie } from '../../src/context.js'

export async function GET(req) {
  const session = sessionFromRequest(req)
  if (session) return Response.redirect(new URL('/', req.url), 302)

  const url = new URL(req.url)
  const inviteToken = url.searchParams.get('invite') ?? ''
  const shouldShowSignup = !!inviteToken
  return { error: null, shouldShowSignup, invite_token: inviteToken }
}

export async function POST(req) {
  const form = await req.formData()
  const action = form.get('_action')

  try {
    if (action === 'signin') {
      const handle = form.get('handle')?.trim()
      const password = form.get('password')
      const result = await auth.signInWithPassword({ handle, password })
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/',
          'Set-Cookie': sessionCookie(result.sessionToken),
        }
      })
    }

    if (action === 'signup') {
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
    }

    return new Response('Bad request', { status: 400 })
  } catch (err) {
    const showSignup = action === 'signup'
    const invite_token = showSignup ? (form.get('invite_token') ?? '') : ''
    return {
      error: err.message ?? 'Something went wrong',
      showSignup,
      invite_token,
    }
  }
}
