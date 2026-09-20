/**
 * GET /api/user/avatar/:userId — serve the user's profile photo
 */

const AVATARS_DIR = process.env.AVATARS_DIR ?? './data/avatars'

export async function GET(req) {
  const parts = new URL(req.url).pathname.split('/')
  // pathname: /api/user/avatar/<userId>  (or /base/api/user/avatar/<userId>)
  const userId = parts[parts.length - 1]
  if (!userId) return new Response('Not Found', { status: 404 })

  // Sanitize: userId may only contain alphanumeric, hyphens, underscores, dots
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(userId)) {
    return new Response('Bad Request', { status: 400 })
  }

  const filePath = `${AVATARS_DIR}/${userId}`
  const mimePath = `${AVATARS_DIR}/${userId}.mime`

  const file = Bun.file(filePath)
  if (!(await file.exists())) return new Response('Not Found', { status: 404 })

  let contentType = 'image/jpeg'
  try {
    const mimeFile = Bun.file(mimePath)
    if (await mimeFile.exists()) {
      contentType = (await mimeFile.text()).trim()
    }
  } catch { /* use default */ }

  return new Response(file, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
