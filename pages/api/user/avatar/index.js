/**
 * POST /api/user/avatar  — upload a profile photo (multipart/form-data, field: "file")
 * DELETE /api/user/avatar — remove the profile photo
 *
 * Accepts both human session cookies and bot Bearer tokens.
 * Both endpoints broadcast user.profile_updated to all connected clients.
 */
import { unlinkSync } from 'node:fs'
import { sessionFromRequest, botUserFromRequest, auth, chatServer } from '../../../../src/context.js'

const AVATARS_DIR = process.env.AVATARS_DIR ?? './data/avatars'
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const MAX_BYTES = 5 * 1024 * 1024  // 5 MB

function _avatarPath(userId) {
  return `${AVATARS_DIR}/${userId}`
}

function _mimePath(userId) {
  return `${AVATARS_DIR}/${userId}.mime`
}

function _avatarPublicUrl(req, userId) {
  const basePath = new URL(req.url).pathname.replace(/\/api\/user\/avatar.*$/, '')
  return `${basePath}/api/user/avatar/${encodeURIComponent(userId)}`
}

async function _resolveUserId(req) {
  const session = sessionFromRequest(req)
  if (session?.user) return session.user.user_id
  const bot = await botUserFromRequest(req)
  if (bot?.user_id) return bot.user_id
  return null
}

export async function POST(req) {
  const userId = await _resolveUserId(req)
  if (!userId) return new Response('Unauthorized', { status: 401 })

  const ct = req.headers.get('content-type') ?? ''

  // JSON: set initials and/or color (merged — omitted fields keep their current value).
  if (ct.includes('application/json')) {
    let body
    try { body = await req.json() } catch {
      return new Response('Bad Request', { status: 400 })
    }
    const current  = auth.getUser(userId)
    const initials = 'initials' in body ? (body.initials?.trim().slice(0, 3) || null) : (current?.avatar_initials ?? null)
    const color    = 'color'    in body ? (body.color?.trim() || null)                : (current?.avatar_color    ?? null)
    auth.updateAvatar(userId, { initials, color })
    const updated = auth.getUser(userId)
    chatServer?.broadcastToAll?.({
      t: 'user.profile_updated', ok: true,
      body: { user_id: userId, avatar_initials: updated?.avatar_initials ?? null, avatar_color: updated?.avatar_color ?? null, avatar_url: updated?.avatar_url ?? null, display_name: updated?.display_name ?? null }
    })
    return Response.json({ ok: true }, { status: 200 })
  }

  let formData
  try {
    formData = await req.formData()
  } catch {
    return new Response('Bad Request: expected multipart/form-data', { status: 400 })
  }

  const fileEntry = formData.get('file')
  if (!fileEntry || typeof fileEntry === 'string') {
    return new Response('Bad Request: file required', { status: 400 })
  }

  if (fileEntry.size > MAX_BYTES) {
    return new Response('Bad Request: file too large (max 5 MB)', { status: 400 })
  }

  const mime = fileEntry.type?.split(';')[0].trim().toLowerCase() || ''
  if (!ALLOWED_MIME.has(mime)) {
    return new Response('Unsupported Media Type: must be JPEG, PNG, GIF, or WebP', { status: 415 })
  }

  const buf = await fileEntry.arrayBuffer()
  await Bun.write(_avatarPath(userId), buf)
  await Bun.write(_mimePath(userId), mime)

  const avatarUrl = `${_avatarPublicUrl(req, userId)}?v=${Date.now()}`
  auth.updateAvatarUrl(userId, avatarUrl)

  // Broadcast to all connected clients
  const user = auth.getUser(userId)
  chatServer?.broadcastToAll?.({
    t: 'user.profile_updated', ok: true,
    body: { user_id: userId, avatar_initials: user?.avatar_initials ?? null, avatar_color: user?.avatar_color ?? null, avatar_url: avatarUrl, display_name: user?.display_name ?? null }
  })

  return Response.json({ avatar_url: avatarUrl }, { status: 200 })
}

export async function DELETE(req) {
  const userId = await _resolveUserId(req)
  if (!userId) return new Response('Unauthorized', { status: 401 })

  // Remove files (ignore if they don't exist)
  try { unlinkSync(_avatarPath(userId)) } catch { /* ignore */ }
  try { unlinkSync(_mimePath(userId)) } catch { /* ignore */ }

  auth.updateAvatarUrl(userId, null)

  const user = auth.getUser(userId)
  chatServer?.broadcastToAll?.({
    t: 'user.profile_updated', ok: true,
    body: { user_id: userId, avatar_initials: user?.avatar_initials ?? null, avatar_color: user?.avatar_color ?? null, avatar_url: null, display_name: user?.display_name ?? null }
  })

  return new Response(null, { status: 204 })
}
