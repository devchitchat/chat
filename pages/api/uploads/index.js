/**
 * POST /api/uploads
 *
 * Accepts multipart/form-data with fields:
 *   file      — binary file
 *   channel_id — target channel
 *
 * Returns 200 { upload_id, url, original_name, mime_type, size_bytes }
 * or 4xx/5xx on error.
 */
import { sessionFromRequest, uploadService } from '../../../src/context.js'
import { ServiceError } from '../../../src/util/errors.js'

const MAGIC_BYTES = 16

export async function POST(req) {
  const session = sessionFromRequest(req)
  if (!session) return new Response('Unauthorized', { status: 401 })

  let formData
  try {
    formData = await req.formData()
  } catch {
    return new Response('Bad Request: expected multipart/form-data', { status: 400 })
  }

  const channelId = formData.get('channel_id')
  if (!channelId) return new Response('Bad Request: channel_id required', { status: 400 })

  const fileEntry = formData.get('file')
  if (!fileEntry || typeof fileEntry === 'string') {
    return new Response('Bad Request: file required', { status: 400 })
  }

  const filename = fileEntry.name || 'upload'
  const sizeBytes = fileEntry.size

  // Read the full file into memory — needed for MIME detection and storage
  const fullBuf = await fileEntry.arrayBuffer()
  const buf = new Uint8Array(fullBuf)
  const magicBuf = buf.slice(0, MAGIC_BYTES)

  try {
    const result = await uploadService.upload({
      userId: session.user.user_id,
      channelId,
      userRoles: session.user.roles,
      filename,
      stream: buf,
      sizeBytes,
      magicBuf,
    })
    return Response.json(result, { status: 200 })
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = { FORBIDDEN: 403, NOT_FOUND: 404, BAD_REQUEST: 400 }[err.code] ?? 500
      return Response.json({ error: err.message }, { status })
    }
    if (err.code === 'UNSUPPORTED_TYPE') {
      return Response.json({ error: err.message }, { status: 415 })
    }
    throw err
  }
}
