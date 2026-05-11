import { sessionFromRequest, userSettingsService } from '../../../src/context.js'

export async function GET(req) {
  const session = sessionFromRequest(req)
  if (!session) return new Response('Unauthorized', { status: 401 })
  const result = userSettingsService.getSettings(session.user.user_id)
  return Response.json(result)
}

export async function PUT(req) {
  const session = sessionFromRequest(req)
  if (!session) return new Response('Unauthorized', { status: 401 })

  let body
  try {
    body = await req.json()
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const { settings, updated_at } = body
  if (typeof updated_at !== 'number') return new Response('Bad Request', { status: 400 })

  const result = userSettingsService.putSettings(session.user.user_id, settings ?? {}, updated_at)
  return Response.json(result)
}
