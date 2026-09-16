import { requireAdminSession } from '../../../src/adminAuth.js'
import { botService } from '../../../src/context.js'
import { randomToken } from '../../../src/util/crypto.js'
import { p } from '../../../src/config.js'
import { storeTokenFlash } from '../../../src/util/tokenFlash.js'

export function GET(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session

  const bots = botService.listBots({ requestingUserId: session.user.user_id })

  return {
    user: session.user,
    pageTitle: 'Admin — Bots',
    bots: bots.map(b => ({
      ...b,
      created_at_fmt: new Date(b.created_at).toLocaleString(),
    })),
  }
}

export async function POST(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session

  const form = await req.formData()
  const handle = form.get('handle')?.trim()
  const displayName = form.get('display_name')?.trim() || handle
  const tokenLabel = form.get('token_label')?.trim() || null

  const result = botService.createBot({
    handle,
    displayName,
    tokenLabel,
    requestingUserId: session.user.user_id,
  })

  const flashId = randomToken(8)
  storeTokenFlash(flashId, result.token)
  return Response.redirect(p(`/admin/bots/${result.userId}?flash_id=${encodeURIComponent(flashId)}`), 303)
}
