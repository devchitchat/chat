/**
 * parseMentions — extract @handle mentions from a message and resolve them to users.
 *
 * @param {string} text — raw message text
 * @param {Array<{ user_id: string, handle: string }>} members — channel members to match against
 * @returns {Array<{ user_id: string, handle: string }>} — deduplicated matched members
 */
export function parseMentions(text, members = []) {
  if (!text || members.length === 0) return []
  const byHandle = new Map(
    members
      .filter(m => m.handle)
      .map(m => [m.handle.toLowerCase(), m])
  )
  const seen = new Set()
  const results = []
  const pattern = /@([a-zA-Z0-9_.-]+)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const handle = match[1].toLowerCase()
    if (byHandle.has(handle) && !seen.has(handle)) {
      seen.add(handle)
      results.push(byHandle.get(handle))
    }
  }
  return results
}
