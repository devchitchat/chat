import { requireAdminSession } from '../../../src/adminAuth.js'
import { auth } from '../../../src/context.js'

function getTargetUserId(req) {
  return new URL(req.url).pathname.split('/').pop()
}

export function GET(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session

  const targetUserId = getTargetUserId(req)
  const target = auth.getUser(targetUserId)
  if (!target) return new Response('User not found', { status: 404 })

  const url = new URL(req.url)
  const flash = url.searchParams.get('flash') ?? null

  return {
    user: session.user,
    pageTitle: `Admin — Edit ${target.handle}`,
    target,
    targetRolesJson: JSON.stringify(target.roles),
    isAdmin: target.roles.includes('admin'),
    isUser: target.roles.includes('user'),
    isGuest: target.roles.includes('guest'),
    isBot: target.roles.includes('bot'),
    flash,
  }
}

export async function POST(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session

  const targetUserId = getTargetUserId(req)
  const form = await req.formData()
  const action = form.get('action')

  if (action === 'set_display_name') {
    const displayName = form.get('display_name')
    auth.adminUpdateDisplayName({ targetUserId, displayName, requestingUserId: session.user.user_id })
    return Response.redirect(new URL(`/admin/users/${targetUserId}?flash=display_name_updated`, req.url), 303)
  }

  if (action === 'set_roles') {
    const roles = form.getAll('roles')
    auth.setUserRoles({ targetUserId, roles, requestingUserId: session.user.user_id })
    return Response.redirect(new URL(`/admin/users/${targetUserId}?flash=roles_updated`, req.url), 303)
  }

  if (action === 'set_password') {
    const newPassword = form.get('new_password')
    await auth.adminSetPassword({ targetUserId, newPassword, requestingUserId: session.user.user_id })
    return Response.redirect(new URL(`/admin/users/${targetUserId}?flash=password_updated`, req.url), 303)
  }

  return new Response('Bad request', { status: 400 })
}
