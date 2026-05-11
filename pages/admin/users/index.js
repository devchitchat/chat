import { requireAdminSession } from '../../../src/adminAuth.js'
import { auth } from '../../../src/context.js'

export function GET(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session

  const users = auth.listUsers({ requestingUserId: session.user.user_id })

  return {
    user: session.user,
    pageTitle: 'Admin — Users',
    users: users.map(u => ({
      ...u,
      isAdmin: u.roles.includes('admin'),
      isBot: u.roles.includes('bot'),
      created_at_fmt: new Date(u.created_at).toLocaleString(),
    })),
  }
}
