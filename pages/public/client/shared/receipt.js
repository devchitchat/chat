/**
 * Browser-side receipt helpers — no Node/server imports.
 * Mirrors the server-side versions in src/core/receipt.js; keep in sync.
 */

/**
 * Count words in a plain-text or markdown string.
 */
export function wordCount(text) {
  if (!text) return 0
  return text.trim().split(/\s+/).filter(Boolean).length
}

/**
 * Derive a display title from the first sentence of a markdown body.
 * Strips common markdown syntax, takes up to maxLen characters, and
 * appends '…' if truncated.
 *
 * @param {string|null|undefined} body
 * @param {number} [maxLen=100]
 * @returns {string}
 */
export function deriveTitle(body, maxLen = 100) {
  if (!body) return ''

  const plain = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, '$1')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .trim()

  const match = plain.match(/^([^.!?\n]+[.!?]?)/)
  const sentence = (match ? match[1] : plain).trim()

  if (sentence.length <= maxLen) return sentence
  return sentence.slice(0, maxLen - 1) + '…'
}
