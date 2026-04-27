import { sessionFromRequest } from '../src/context.js'

export async function data(req) {
  const session = sessionFromRequest(req)
  return {
    user: session?.user ?? null,
    pageTitle: 'Chat',
  }
}
