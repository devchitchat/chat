/**
 * src/markdown.js — project-local markdown renderer.
 *
 * Wraps @devchitchat/index97/markdown but disables Bun's autolink feature.
 * Bun's autolinker has a bug where it greedily consumes '*' from surrounding
 * markdown emphasis syntax (e.g. **url**), producing broken output like:
 *   <a href="url*">url*</a>*
 *
 * With autolinks disabled, bare URLs remain as plain text in rendered HTML.
 * The client-side applyInlineRenderingToTextNodes() then links them correctly
 * (its regex excludes '*' from URLs, so **url** stays bold with a working link).
 */
import { parseFrontMatter } from '@devchitchat/index97/markdown'

export function renderMarkdown(src) {
  const { data, content } = parseFrontMatter(src)
  const html = Bun.markdown.html(content, {
    tables: true,
    strikethrough: true,
    tasklists: true,
    autolinks: false,
  })
  return { html, data }
}
