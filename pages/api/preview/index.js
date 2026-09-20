/**
 * POST /api/preview
 *
 * Renders markdown text server-side and returns the HTML.
 * Used by the client-side compose overlay preview tab.
 *
 * Body: { text: string }
 * Returns: { html: string }
 */
import { sessionFromRequest } from '../../../src/context.js'
import { renderMarkdown } from '../../../src/markdown.js'

export async function POST(req) {
  const session = sessionFromRequest(req)
  if (!session?.user) return new Response('Unauthorized', { status: 401 })

  let body
  try {
    body = await req.json()
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const text = String(body.text ?? '').slice(0, 50_000)
  const { html } = renderMarkdown(text)
  return Response.json({ html })
}
