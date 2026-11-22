/**
 * Tests for pure agent-card receipt helpers in src/core/receipt.js.
 * No DOM, no I/O — just pure functions.
 */
import { test, expect, describe } from 'bun:test'
import { wordCount, deriveTitle, validateReceipt } from '../src/core/receipt.js'

// ── wordCount ────────────────────────────────────────────────────────────────

describe('wordCount', () => {
  test('returns 0 for empty string', () => {
    expect(wordCount('')).toBe(0)
  })

  test('returns 0 for null/undefined', () => {
    expect(wordCount(null)).toBe(0)
    expect(wordCount(undefined)).toBe(0)
  })

  test('counts words separated by spaces', () => {
    expect(wordCount('hello world')).toBe(2)
  })

  test('counts words separated by multiple spaces / newlines', () => {
    expect(wordCount('one  two\nthree\t four')).toBe(4)
  })

  test('counts a single word', () => {
    expect(wordCount('hello')).toBe(1)
  })

  test('handles markdown body', () => {
    // "Fixed 5 failing tests" = 4 words; "## Summary\n\nAll passing." = 3 words
    expect(wordCount('Fixed 5 failing tests\n\n## Summary\n\nAll passing.')).toBe(8)
  })
})

// ── deriveTitle ──────────────────────────────────────────────────────────────

describe('deriveTitle', () => {
  test('returns empty string for falsy input', () => {
    expect(deriveTitle('')).toBe('')
    expect(deriveTitle(null)).toBe('')
    expect(deriveTitle(undefined)).toBe('')
  })

  test('takes first sentence ending with a period', () => {
    expect(deriveTitle('Fixed the bug. More details below.')).toBe('Fixed the bug.')
  })

  test('takes first sentence ending with an exclamation', () => {
    expect(deriveTitle('Tests pass! All green.')).toBe('Tests pass!')
  })

  test('takes first sentence ending with a question mark', () => {
    expect(deriveTitle('Should I push? Let me know.')).toBe('Should I push?')
  })

  test('stops at a newline when no sentence terminator', () => {
    expect(deriveTitle('Fixed the failing tests\nHere is the summary')).toBe('Fixed the failing tests')
  })

  test('strips markdown headings', () => {
    expect(deriveTitle('## Fixed 5 tests\nAll passing.')).toBe('Fixed 5 tests')
  })

  test('strips bold/italic markers', () => {
    expect(deriveTitle('**Fixed** the *bug*. Details here.')).toBe('Fixed the bug.')
  })

  test('strips inline code', () => {
    // Inline code is removed; the sentence detector stops at the resulting period
    expect(deriveTitle('Ran `bun test`. All green.')).toBe('Ran .')
  })

  test('truncates to 100 characters with ellipsis', () => {
    const long = 'A'.repeat(110)
    const result = deriveTitle(long)
    expect(result.length).toBe(100)
    expect(result.endsWith('…')).toBe(true)
  })

  test('does not add ellipsis when within limit', () => {
    const short = 'Fixed the tests.'
    expect(deriveTitle(short)).toBe('Fixed the tests.')
    expect(deriveTitle(short).endsWith('…')).toBe(false)
  })

  test('respects custom maxLen', () => {
    const result = deriveTitle('Hello world', 5)
    expect(result.length).toBe(5)
    expect(result).toBe('Hell…')
  })
})

// ── validateReceipt ──────────────────────────────────────────────────────────

describe('validateReceipt', () => {
  test('returns null for non-object input', () => {
    expect(validateReceipt(null)).toBe(null)
    expect(validateReceipt(undefined)).toBe(null)
    expect(validateReceipt('string')).toBe(null)
    expect(validateReceipt(42)).toBe(null)
  })

  test('returns null when title is missing', () => {
    expect(validateReceipt({ tone: 'ok' })).toBe(null)
  })

  test('returns null when title is empty', () => {
    expect(validateReceipt({ title: '' })).toBe(null)
    expect(validateReceipt({ title: '   ' })).toBe(null)
  })

  test('accepts a minimal valid receipt', () => {
    const result = validateReceipt({ title: 'Fixed tests' })
    expect(result).not.toBe(null)
    expect(result.title).toBe('Fixed tests')
  })

  test('clamps title to 100 characters', () => {
    const result = validateReceipt({ title: 'A'.repeat(120) })
    expect(result.title.length).toBe(100)
  })

  test('accepts valid tone', () => {
    for (const tone of ['ok', 'warn', 'error', 'neutral']) {
      expect(validateReceipt({ title: 'T', tone }).tone).toBe(tone)
    }
  })

  test('drops invalid tone', () => {
    const result = validateReceipt({ title: 'T', tone: 'info' })
    expect(result.tone).toBeUndefined()
  })

  test('accepts chips array', () => {
    const result = validateReceipt({
      title: 'T',
      chips: [{ text: '140/140 passing', tone: 'ok' }],
    })
    expect(result.chips).toHaveLength(1)
    expect(result.chips[0].text).toBe('140/140 passing')
    expect(result.chips[0].tone).toBe('ok')
  })

  test('limits chips to 5 entries', () => {
    const chips = Array.from({ length: 8 }, (_, i) => ({ text: `chip ${i}` }))
    const result = validateReceipt({ title: 'T', chips })
    expect(result.chips).toHaveLength(5)
  })

  test('clamps chip text to 32 characters', () => {
    const result = validateReceipt({
      title: 'T',
      chips: [{ text: 'A'.repeat(50), tone: 'ok' }],
    })
    expect(result.chips[0].text.length).toBe(32)
  })

  test('drops chips with empty text', () => {
    const result = validateReceipt({
      title: 'T',
      chips: [{ text: '' }, { text: 'valid' }],
    })
    expect(result.chips).toHaveLength(1)
    expect(result.chips[0].text).toBe('valid')
  })

  test('defaults chip tone to neutral when invalid', () => {
    const result = validateReceipt({
      title: 'T',
      chips: [{ text: 'chip', tone: 'purple' }],
    })
    expect(result.chips[0].tone).toBe('neutral')
  })

  test('accepts a note string', () => {
    const result = validateReceipt({ title: 'T', note: 'Not tested on device.' })
    expect(result.note).toBe('Not tested on device.')
  })

  test('clamps note to 200 characters', () => {
    const result = validateReceipt({ title: 'T', note: 'N'.repeat(250) })
    expect(result.note.length).toBe(200)
  })

  test('drops empty note', () => {
    const result = validateReceipt({ title: 'T', note: '   ' })
    expect(result.note).toBeUndefined()
  })

  test('accepts a valid ask with question and actions', () => {
    const result = validateReceipt({
      title: 'T',
      ask: { question: 'Push?', actions: ['Push', 'Not yet'] },
    })
    expect(result.ask.question).toBe('Push?')
    expect(result.ask.actions).toEqual(['Push', 'Not yet'])
  })

  test('clamps ask.question to 200 characters', () => {
    const result = validateReceipt({
      title: 'T',
      ask: { question: 'Q'.repeat(250), actions: ['Yes'] },
    })
    expect(result.ask.question.length).toBe(200)
  })

  test('limits ask.actions to 4 entries', () => {
    const result = validateReceipt({
      title: 'T',
      ask: { question: 'Q?', actions: ['A', 'B', 'C', 'D', 'E', 'F'] },
    })
    expect(result.ask.actions).toHaveLength(4)
  })

  test('clamps each action label to 32 characters', () => {
    const result = validateReceipt({
      title: 'T',
      ask: { question: 'Q?', actions: ['A'.repeat(50)] },
    })
    expect(result.ask.actions[0].length).toBe(32)
  })

  test('drops ask when actions array is empty', () => {
    const result = validateReceipt({
      title: 'T',
      ask: { question: 'Push?', actions: [] },
    })
    expect(result.ask).toBeUndefined()
  })

  test('drops ask when question is missing', () => {
    const result = validateReceipt({
      title: 'T',
      ask: { actions: ['Push'] },
    })
    expect(result.ask).toBeUndefined()
  })

  test('accepts a valid answered state', () => {
    const result = validateReceipt({
      title: 'T',
      ask: {
        question: 'Push?',
        actions: ['Push', 'Not yet'],
        answered: { action: 'Push', by: 'u_abc', at: 1234567890 },
      },
    })
    expect(result.ask.answered.action).toBe('Push')
    expect(result.ask.answered.by).toBe('u_abc')
    expect(result.ask.answered.at).toBe(1234567890)
  })

  test('ignores unknown top-level fields', () => {
    const result = validateReceipt({ title: 'T', unknown: 'field', color: 'red' })
    expect(result.unknown).toBeUndefined()
    expect(result.color).toBeUndefined()
  })
})
