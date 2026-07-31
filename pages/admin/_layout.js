import { sessionFromRequest } from '../../src/context.js'
import { BASE_PATH } from '../../src/config.js'

export async function data(req) {
  const session = sessionFromRequest(req)
  const user = session?.user ?? null
  return { user, base: BASE_PATH }
}
