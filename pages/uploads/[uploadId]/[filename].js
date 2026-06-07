/**
 * GET /uploads/:uploadId/:filename
 *
 * Authenticated file download handler.
 * `:filename` is cosmetic — the actual file is located by uploadId + stored_name from DB.
 * Path traversal is impossible because stored_name is opaque and never interpolated from URL.
 */
import { sessionFromRequest, botUserFromRequest, uploadService } from '../../../src/context.js'
import { ServiceError, httpStatus } from '../../../src/util/errors.js'

export async function GET(req) {
  const session  = sessionFromRequest(req)
  const botUser  = session ? null : await botUserFromRequest(req)
  const reqUser  = session?.user ?? botUser
  if (!reqUser) return new Response('Unauthorized', { status: 401 })

  const parts = new URL(req.url).pathname.split('/')
  // pathname: /uploads/<uploadId>/<filename>
  const uploadId = parts[2]

  if (!uploadId) return new Response('Not Found', { status: 404 })

  try {
    const { stream, mimeType, contentDisposition } = await uploadService.streamFile({
      uploadId,
      requestingUserId: reqUser.user_id,
      userRoles: reqUser.roles ?? [],
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': contentDisposition,
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = httpStatus(err)
      return new Response(err.message, { status })
    }
    throw err
  }
}
