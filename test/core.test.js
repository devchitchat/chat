import { test, expect, describe } from 'bun:test'
import { parseMentions } from '../src/core/mentions.js'
import { buildDmChannelName } from '../src/core/dm.js'
import { isAdmin, isGuest, isBot } from '../src/core/roles.js'
import { validateMimeType, isForcedDownload } from '../src/core/uploads.js'

// ── parseMentions ──────────────────────────────────────────────────────────────

describe('parseMentions', () => {
  const members = [
    { user_id: 'u1', handle: 'alice' },
    { user_id: 'u2', handle: 'bob' },
    { user_id: 'u3', handle: 'carol' },
  ]

  test('returns empty array when text is empty', () => {
    expect(parseMentions('', members)).toEqual([])
  })

  test('returns empty array when members list is empty', () => {
    expect(parseMentions('@alice hello', [])).toEqual([])
  })

  test('resolves a single mention', () => {
    const result = parseMentions('hey @alice', members)
    expect(result).toHaveLength(1)
    expect(result[0].user_id).toBe('u1')
    expect(result[0].handle).toBe('alice')
  })

  test('resolves multiple distinct mentions', () => {
    const result = parseMentions('@alice and @bob', members)
    expect(result).toHaveLength(2)
    expect(result.map(r => r.handle)).toEqual(expect.arrayContaining(['alice', 'bob']))
  })

  test('deduplicates repeated mentions of the same user', () => {
    const result = parseMentions('@alice @alice again @alice', members)
    expect(result).toHaveLength(1)
  })

  test('is case-insensitive for handles', () => {
    const result = parseMentions('@Alice', members)
    expect(result).toHaveLength(1)
    expect(result[0].user_id).toBe('u1')
  })

  test('ignores mentions that do not match any member', () => {
    expect(parseMentions('@nobody', members)).toEqual([])
  })

  test('ignores members with no handle', () => {
    const result = parseMentions('@alice', [{ user_id: 'u_x', handle: null }, ...members])
    expect(result).toHaveLength(1)
  })
})

// ── buildDmChannelName ─────────────────────────────────────────────────────────

describe('buildDmChannelName', () => {
  test('produces a deterministic name regardless of argument order', () => {
    expect(buildDmChannelName('u_aaa', 'u_zzz')).toBe(buildDmChannelName('u_zzz', 'u_aaa'))
  })

  test('produces a different name for different pairs', () => {
    expect(buildDmChannelName('u_a', 'u_b')).not.toBe(buildDmChannelName('u_a', 'u_c'))
  })

  test('includes both user IDs in the name', () => {
    const name = buildDmChannelName('u_alice', 'u_bob')
    expect(name).toContain('u_alice')
    expect(name).toContain('u_bob')
  })

  test('name starts with dm: prefix', () => {
    expect(buildDmChannelName('u_x', 'u_y')).toMatch(/^dm:/)
  })
})

// ── roles ──────────────────────────────────────────────────────────────────────

describe('roles', () => {
  test('isAdmin returns true when admin role is present', () => {
    expect(isAdmin(['admin', 'user'])).toBe(true)
  })

  test('isAdmin returns false for non-admin roles', () => {
    expect(isAdmin(['user'])).toBe(false)
    expect(isAdmin([])).toBe(false)
  })

  test('isGuest returns true when guest role is present', () => {
    expect(isGuest(['guest'])).toBe(true)
  })

  test('isBot returns true when bot role is present', () => {
    expect(isBot(['bot'])).toBe(true)
  })

  test('role predicates default to empty array', () => {
    expect(isAdmin()).toBe(false)
    expect(isGuest()).toBe(false)
    expect(isBot()).toBe(false)
  })
})

// ── validateMimeType / isForcedDownload ────────────────────────────────────────

describe('validateMimeType', () => {
  test('detects JPEG by magic bytes', () => {
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
    expect(validateMimeType(buf, 'photo.jpg')).toBe('image/jpeg')
  })

  test('detects PNG by magic bytes', () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(validateMimeType(buf, 'image.png')).toBe('image/png')
  })

  test('detects PDF by magic bytes', () => {
    const buf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0])
    expect(validateMimeType(buf, 'doc.pdf')).toBe('application/pdf')
  })

  test('detects plain text by extension for known text types', () => {
    const buf = new Uint8Array([104, 101, 108, 108, 111]) // "hello"
    expect(validateMimeType(buf, 'notes.md')).toBe('text/plain')
    expect(validateMimeType(buf, 'data.json')).toBe('text/plain')
    expect(validateMimeType(buf, 'script.js')).toBe('text/plain')
  })

  test('svg extension falls back to text/plain (svg is in TEXT_EXTENSIONS)', () => {
    // svg is listed in TEXT_EXTENSIONS so it returns text/plain for non-binary content;
    // the svg-specific branch is unreachable for non-binary buffers.
    const buf = new Uint8Array([60, 115, 118, 103]) // "<svg" — non-binary text
    expect(validateMimeType(buf, 'icon.svg')).toBe('text/plain')
  })

  test('throws UNSUPPORTED_TYPE for unrecognized files', () => {
    const buf = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
    expect(() => validateMimeType(buf, 'unknown.bin')).toThrow()
    try {
      validateMimeType(buf, 'unknown.bin')
    } catch (err) {
      expect(err.code).toBe('UNSUPPORTED_TYPE')
    }
  })
})

describe('isForcedDownload', () => {
  test('forces download for dangerous MIME types', () => {
    expect(isForcedDownload('text/html')).toBe(true)
    expect(isForcedDownload('application/javascript')).toBe(true)
    expect(isForcedDownload('application/x-sh')).toBe(true)
  })

  test('does not force download for safe types', () => {
    expect(isForcedDownload('image/jpeg')).toBe(false)
    expect(isForcedDownload('image/png')).toBe(false)
    expect(isForcedDownload('application/pdf')).toBe(false)
    expect(isForcedDownload('text/plain')).toBe(false)
  })
})
