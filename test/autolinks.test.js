import { test, expect } from 'bun:test'
import { renderMarkdown } from '../src/markdown.js'

const md = (src) => Bun.markdown.html(src, { autolinks: true, tables: true, strikethrough: true, tasklists: true })

test('bare URL becomes a link', () => {
    expect(md('https://example.com')).toBe('<p><a href="https://example.com">https://example.com</a></p>\n')
})

test('URL wrapped in ** renders as bold link with no trailing asterisk', () => {
    expect(md('**https://example.com**')).toBe('<p><strong><a href="https://example.com">https://example.com</a></strong></p>\n')
})

test('URL wrapped in * renders as italic link with no trailing asterisk', () => {
    expect(md('*https://example.com*')).toBe('<p><em><a href="https://example.com">https://example.com</a></em></p>\n')
})

test('URL in bold sentence renders correctly', () => {
    expect(md('**check out https://example.com now**')).toBe('<p><strong>check out <a href="https://example.com">https://example.com</a> now</strong></p>\n')
})

test('URL followed by period does not include period in href', () => {
    expect(md('visit https://example.com.')).toBe('<p>visit <a href="https://example.com">https://example.com</a>.</p>\n')
})

test('URL with path wrapped in ** (Bun autolinks bug — do not fix)', () => {
    // This is a known Bun bug: autolinks consumes * from emphasis when URL has a path.
    // Expected broken output is intentional — it documents why autolinks is disabled in src/markdown.js.
    const broken = md('**https://example.com/path/to/page**')
    expect(broken).not.toBe('<p><strong><a href="https://example.com/path/to/page">https://example.com/path/to/page</a></strong></p>\n')
})

test('renderMarkdown: URL with path wrapped in ** renders without trailing asterisk', () => {
    // src/markdown.js disables autolinks to avoid the Bun bug above.
    // Client-side applyInlineRenderingToTextNodes() handles linking instead.
    // The rendered HTML should have bold text with a plain URL — no asterisk in the href.
    const { html } = renderMarkdown('**https://example.com/path/to/page**')
    console.log(html)
    expect(html).not.toContain('href="https://example.com/path/to/page*"')
    expect(html).toContain('<strong>')
})

