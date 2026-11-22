/**
 * Pure helpers for agent card receipts.
 * No DOM dependency — all functions are testable with bun:test.
 */

/**
 * Count words in a plain-text or markdown string.
 * Splits on whitespace; ignores empty tokens.
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
    // Remove fenced code blocks first so their content doesn't pollute the sentence
    .replace(/```[\s\S]*?```/g, '')
    // Inline code
    .replace(/`[^`]*`/g, '')
    // Markdown images → alt text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Markdown links → link text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // ATX headings (##, ###, etc.)
    .replace(/^#{1,6}\s+/gm, '')
    // Bold / italic (**, *, __, _)
    .replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, '$1')
    // Setext-style horizontal rules / separators
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Leading list markers
    .replace(/^\s*[-*+]\s+/gm, '')
    .trim()

  // Take first sentence (period, exclamation, question) or first line
  const match = plain.match(/^([^.!?\n]+[.!?]?)/)
  const sentence = (match ? match[1] : plain).trim()

  if (sentence.length <= maxLen) return sentence
  return sentence.slice(0, maxLen - 1) + '…'
}

const VALID_TONES = new Set(['ok', 'warn', 'error', 'neutral'])

/**
 * Validate and clamp a receipt object from the model.
 * Returns a sanitized receipt, or null if it is invalid.
 *
 * Schema:
 *   title    string, max 100 chars (required)
 *   tone     'ok' | 'warn' | 'error' | 'neutral'
 *   chips    [{ text: string max 32, tone: string }], max 5 entries
 *   note     string, max 200 chars
 *   ask      { question: string max 200, actions: string[] max 4×32, answered? }
 *
 * @param {unknown} obj
 * @returns {{ title, tone?, chips?, note?, ask? } | null}
 */
export function validateReceipt(obj) {
  if (!obj || typeof obj !== 'object') return null
  if (typeof obj.title !== 'string' || !obj.title.trim()) return null

  const receipt = { title: obj.title.trim().slice(0, 100) }

  if (obj.tone && VALID_TONES.has(obj.tone)) {
    receipt.tone = obj.tone
  }

  if (Array.isArray(obj.chips)) {
    const chips = obj.chips
      .slice(0, 5)
      .filter(c => c && typeof c.text === 'string' && c.text.trim())
      .map(c => ({
        text: c.text.trim().slice(0, 32),
        tone: VALID_TONES.has(c.tone) ? c.tone : 'neutral',
      }))
    if (chips.length > 0) receipt.chips = chips
  }

  if (typeof obj.note === 'string' && obj.note.trim()) {
    receipt.note = obj.note.trim().slice(0, 200)
  }

  if (obj.ask && typeof obj.ask === 'object') {
    const { question, actions, answered } = obj.ask
    if (
      typeof question === 'string' &&
      question.trim() &&
      Array.isArray(actions) &&
      actions.length > 0
    ) {
      const cleanActions = actions
        .slice(0, 4)
        .filter(a => typeof a === 'string' && a.trim())
        .map(a => a.trim().slice(0, 32))
      if (cleanActions.length > 0) {
        receipt.ask = { question: question.trim().slice(0, 200), actions: cleanActions }

        if (
          answered &&
          typeof answered === 'object' &&
          typeof answered.action === 'string' &&
          typeof answered.by === 'string'
        ) {
          receipt.ask.answered = {
            action: answered.action,
            by:     answered.by,
            at:     typeof answered.at === 'number' ? answered.at : Date.now(),
          }
        }
      }
    }
  }

  return receipt
}
