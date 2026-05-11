import { requireAdminSession } from '../../../src/adminAuth.js'
import { botService } from '../../../src/context.js'

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

  return Response.redirect(
    new URL(`/admin/bots/${result.userId}?created_token=${encodeURIComponent(result.token)}`, req.url),
    303
  )
}
