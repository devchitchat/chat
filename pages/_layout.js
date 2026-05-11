import { sessionFromRequest } from '../src/context.js'

export async function data(req) {
  const session = sessionFromRequest(req)
  const user = session?.user ?? null
  return {
    user,
    isAdmin: user?.roles?.includes('admin') ?? false,
    pageTitle: 'Chat',
  }
}
