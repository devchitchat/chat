import { requireAdminSession } from '../../../src/adminAuth.js'
import { auth } from '../../../src/context.js'

export function GET(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session

  const url = new URL(req.url)
  const createdToken = url.searchParams.get('created') ?? null
  const origin = url.origin

  const invites = auth.listInvites({ requestingUserId: session.user.user_id })
  const now = Date.now()

  return {
    user: session.user,
    pageTitle: 'Admin — Invites',
    createdToken,
    createdLink: createdToken ? `${origin}/registration?invite=${encodeURIComponent(createdToken)}` : null,
    invites: invites.map(inv => ({
      ...inv,
      expired: inv.expires_at <= now,
      exhausted: inv.uses >= inv.max_uses,
      expires_at_fmt: new Date(inv.expires_at).toLocaleString(),
      roles_label: (() => {
        try {
          const r = JSON.parse(inv.initial_roles_json ?? '["user"]')
          return r.includes('guest') ? 'Guest' : 'User'
        } catch { return 'User' }
      })(),
      is_guest: (() => {
        try { return JSON.parse(inv.initial_roles_json ?? '["user"]').includes('guest') } catch { return false }
      })(),
    })),
  }
}

export async function POST(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session

  const form = await req.formData()
  const action = form.get('action')

  if (action === 'create') {
    const ttlHours = Number(form.get('ttl_hours') ?? 24)
    const maxUses = Number(form.get('max_uses') ?? 1)
    const note = form.get('note')?.trim() || null
    const roleValue = form.get('roles') ?? 'user'
    const roles = roleValue === 'guest' ? ['guest'] : ['user']
    const invite = auth.createInvite({
      createdByUserId: session.user.user_id,
      ttlMs: ttlHours * 60 * 60 * 1000,
      maxUses,
      note,
      roles,
    })
    return Response.redirect(
      new URL(`/admin/invites?created=${encodeURIComponent(invite.inviteToken)}`, req.url),
      303
    )
  }

  if (action === 'revoke') {
    const inviteId = form.get('invite_id')
    auth.revokeInvite({ inviteId, requestingUserId: session.user.user_id })
    return Response.redirect(new URL('/admin/invites', req.url), 303)
  }

  return new Response('Bad request', { status: 400 })
}
