/**
 * Admin-only bot avatar API.
 *
 * POST   /api/admin/bot-avatar/:userId   (JSON)      — set initials + color
 * POST   /api/admin/bot-avatar/:userId   (multipart) — upload photo
 * DELETE /api/admin/bot-avatar/:userId               — remove photo
 */
import { unlinkSync } from 'node:fs'
import { requireAdminSession } from '../../../../src/adminAuth.js'
import { auth, chatServer } from '../../../../src/context.js'

const AVATARS_DIR = process.env.AVATARS_DIR ?? './data/avatars'
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const MAX_BYTES = 5 * 1024 * 1024

function _botUserId(req) {
  return new URL(req.url).pathname.split('/').pop()
}

function _broadcast(userId) {
  const user = auth.getUser(userId)
  if (!user) return
  chatServer?.broadcastToAll?.({
    t: 'user.profile_updated', ok: true,
    body: { user_id: userId, avatar_initials: user.avatar_initials ?? null, avatar_color: user.avatar_color ?? null, avatar_url: user.avatar_url ?? null, display_name: user.display_name ?? null }
  })
}

export async function POST(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return new Response('Unauthorized', { status: 401 })

  const botUserId = _botUserId(req)
  if (!botUserId) return new Response('Bad Request', { status: 400 })

  const ct = req.headers.get('content-type') ?? ''

  // Multipart: photo upload
  if (ct.includes('multipart/form-data')) {
    let formData
    try { formData = await req.formData() } catch {
      return new Response('Bad Request', { status: 400 })
    }
    const fileEntry = formData.get('file')
    if (!fileEntry || typeof fileEntry === 'string') return new Response('Bad Request: file required', { status: 400 })
    if (fileEntry.size > MAX_BYTES) return new Response('Bad Request: file too large', { status: 400 })
    const mime = fileEntry.type?.split(';')[0].trim().toLowerCase() || ''
    if (!ALLOWED_MIME.has(mime)) return new Response('Unsupported Media Type', { status: 415 })

    const buf = await fileEntry.arrayBuffer()
    await Bun.write(`${AVATARS_DIR}/${botUserId}`, buf)
    await Bun.write(`${AVATARS_DIR}/${botUserId}.mime`, mime)

    const basePath = new URL(req.url).pathname.replace(/\/api\/admin\/bot-avatar.*$/, '')
    const avatarUrl = `${basePath}/api/user/avatar/${encodeURIComponent(botUserId)}?v=${Date.now()}`
    auth.updateAvatarUrl(botUserId, avatarUrl)
    _broadcast(botUserId)
    return Response.json({ avatar_url: avatarUrl }, { status: 200 })
  }

  // JSON: set initials + color
  let body
  try { body = await req.json() } catch {
    return new Response('Bad Request', { status: 400 })
  }
  const initials = body.initials?.trim().slice(0, 3) || null
  const color    = body.color?.trim() || null
  auth.updateAvatar(botUserId, { initials, color })
  _broadcast(botUserId)
  return Response.json({ ok: true }, { status: 200 })
}

export async function DELETE(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return new Response('Unauthorized', { status: 401 })

  const botUserId = _botUserId(req)
  if (!botUserId) return new Response('Bad Request', { status: 400 })

  try { unlinkSync(`${AVATARS_DIR}/${botUserId}`) } catch { /* ignore */ }
  try { unlinkSync(`${AVATARS_DIR}/${botUserId}.mime`) } catch { /* ignore */ }
  auth.updateAvatarUrl(botUserId, null)
  _broadcast(botUserId)
  return new Response(null, { status: 204 })
}
