/**
 * AgentCardView.js — renders and updates agent card messages.
 *
 * Agent cards are structured, live-updatable messages produced by the agent
 * during a session. They progress through status phases:
 *   thinking → working → streaming → done | error
 *
 * makeAgentCardEl(message, ctx) — creates the initial <article> element.
 * updateAgentCard(article, message, ctx) — patches it in-place on msg.edited.
 *
 * The braille spinner is JS-driven (client-side interval) so it animates
 * independently of the server's 500 ms card update cadence.
 */

import { escHtml, applyAvatarToEl, applyInlineRenderingToTextNodes } from '../shared/messages.js'

// ─────────────────────────────────────────────────────────────────────────────
// Braille spinner
// ─────────────────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const activeSpinners = new WeakMap()  // article → intervalId

function startSpinner(article, spinnerEl) {
  if (activeSpinners.has(article)) return
  let frame = 0
  const id = setInterval(() => {
    spinnerEl.textContent = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
    frame++
  }, 100)
  activeSpinners.set(article, id)
}

function stopSpinner(article) {
  const id = activeSpinners.get(article)
  if (id != null) {
    clearInterval(id)
    activeSpinners.delete(article)
  }
}

function isActive(status) {
  return status === 'thinking' || status === 'working' || status === 'streaming'
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal rendering helpers
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_ICONS = {
  Read: '📖',
  Write: '✏️', Edit: '✏️', MultiEdit: '✏️',
  Bash: '🔧',
  Glob: '🔍', Grep: '🔍',
  WebFetch: '🌐', WebSearch: '🌐',
  TodoWrite: '📋',
}

function toolIcon(name) {
  return TOOL_ICONS[name] ?? '⚙️'
}

function toolInputSummary(name, input) {
  if (!input) return ''
  switch (name) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit':
      return input.file_path ?? ''
    case 'Bash':
      return String(input.command ?? '').slice(0, 60)
    case 'Glob':
      return input.pattern ?? ''
    case 'Grep':
      return input.pattern ?? ''
    case 'WebFetch':
      return input.url ?? ''
    case 'WebSearch':
      return input.query ?? ''
    default:
      return ''
  }
}

function statusLabel(status) {
  switch (status) {
    case 'thinking':  return 'thinking…'
    case 'working':   return 'working…'
    case 'streaming': return 'responding…'
    case 'error':     return 'error'
    default:          return ''
  }
}

function renderToolCalls(toolCalls) {
  if (!toolCalls?.length) return ''
  const rows = toolCalls.map(tc => {
    const icon    = toolIcon(tc.name)
    const summary = toolInputSummary(tc.name, tc.input)
    const label   = escHtml(summary || tc.name)
    const status  = tc.status ?? 'running'
    const mark = status === 'done'  ? '<span class="agent-card-tool-check" aria-hidden="true">✓</span>'
               : status === 'error' ? '<span class="agent-card-tool-err"   aria-hidden="true">✗</span>'
               :                      '<span class="agent-card-tool-running" aria-hidden="true">…</span>'
    return `<div class="agent-card-tool" data-tool-status="${escHtml(status)}">
        <span class="agent-card-tool-icon" aria-hidden="true">${icon}</span>
        <code class="agent-card-tool-input">${label}</code>
        ${mark}
      </div>`
  }).join('')
  return `<div class="agent-card-tools">${rows}</div>`
}

function renderBody(card, renderedText) {
  if (card.status === 'done' || card.status === 'error') {
    // Use server-rendered HTML when available; fall back to escaped plain text.
    const html = renderedText || (card.body ? escHtml(card.body) : '')
    return html ? `<div class="agent-card-body message-text">${html}</div>` : ''
  }
  // Streaming: body may end with a braille cursor — show as pre-wrapped plain text.
  return card.body
    ? `<div class="agent-card-body agent-card-body--streaming">${escHtml(card.body)}</div>`
    : ''
}

function renderUsage(usage) {
  if (!usage) return ''
  const parts = []
  if (usage.inputTokens)  parts.push(`${Number(usage.inputTokens).toLocaleString()} in`)
  if (usage.outputTokens) parts.push(`${Number(usage.outputTokens).toLocaleString()} out`)
  if (usage.costUsd != null) parts.push(`$${Number(usage.costUsd).toFixed(4)}`)
  return parts.length
    ? `<div class="agent-card-footer">${parts.join(' · ')}</div>`
    : ''
}

function renderCardContent(card, renderedText) {
  const label = statusLabel(card.status)
  return `
    <div class="agent-card-header">
      <span class="agent-card-spinner" aria-hidden="true">⠋</span>
      ${label ? `<span class="agent-card-status-label">${escHtml(label)}</span>` : ''}
    </div>
    ${renderToolCalls(card.toolCalls ?? [])}
    ${renderBody(card, renderedText)}
    ${renderUsage(card.usage)}
  `
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a card <article> element for an agent message.
 * Structurally identical to makeMessageEl() but renders .agent-card instead
 * of .message-text.
 *
 * @param {{ msg_id, seq, user_id, user_display_name, ts, text, rendered_text, edited_at, card }} message
 * @param {{ userId?, userHandle?, knownHandles?, getAvatar? }} ctx
 */
export function makeAgentCardEl(message, { userId, userHandle, knownHandles, getAvatar } = {}) {
  const card   = message.card ?? { status: 'thinking', toolCalls: [], body: null, usage: null }
  const time   = new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const isSelf = userId != null && message.user_id === userId

  const article = document.createElement('article')
  article.className        = 'message message--agent-card'
  article.dataset.seq      = message.seq
  article.dataset.msgId    = message.msg_id
  article.dataset.userId   = message.user_id
  article.dataset.rawText  = message.text ?? ''
  article.dataset.editedAt = message.edited_at ?? ''
  article.dataset.cardStatus = card.status ?? 'thinking'

  article.innerHTML = `
    <div class="msg-avatar" data-avatar-user="${escHtml(message.user_id)}" aria-hidden="true"></div>
    <span class="message-handle${isSelf ? '' : ' dm-trigger'}"
          data-user-id="${escHtml(message.user_id)}"
          title="${isSelf ? '' : 'Send a direct message'}">${escHtml(message.user_display_name ?? message.user_id)}</span>
    <time class="message-time" datetime="${message.ts}">${time}</time>
    <div class="agent-card" role="status" aria-live="polite" aria-label="Agent response">
      ${renderCardContent(card, message.rendered_text)}
    </div>
    <div class="reaction-bar"></div>
    <div class="message-hover-actions">
      <span class="quick-picks"></span>
      <button class="btn-react btn-icon" type="button" title="Add reaction" aria-label="Add reaction">🙂</button>
      ${isSelf ? '<button class="btn-msg-actions btn-icon" type="button" title="Message actions">…</button>' : ''}
    </div>
  `

  const avatarEl = article.querySelector('.msg-avatar')
  if (avatarEl) {
    applyAvatarToEl(avatarEl, getAvatar?.(message.user_id) ?? null, message.user_display_name ?? message.user_id)
  }

  if (isActive(card.status)) {
    const spinnerEl = article.querySelector('.agent-card-spinner')
    if (spinnerEl) startSpinner(article, spinnerEl)
  }

  return article
}

/**
 * Patch an existing agent card article in-place after a msg.edited event.
 * Called from MessageListView when the updated message has card data.
 *
 * @param {HTMLElement} article
 * @param {{ msg_id, text, rendered_text, edited_at, card }} message
 * @param {{ userHandle?, knownHandles? }} ctx
 */
export function updateAgentCard(article, message, { userHandle, knownHandles } = {}) {
  const card = message.card ?? {}

  article.dataset.cardStatus = card.status ?? 'thinking'
  if (message.edited_at) article.dataset.editedAt = message.edited_at

  stopSpinner(article)

  const cardEl = article.querySelector('.agent-card')
  if (cardEl) {
    cardEl.innerHTML = renderCardContent(card, message.rendered_text)

    // Apply @mention and URL rendering to the completed body.
    if (card.status === 'done') {
      const bodyEl = cardEl.querySelector('.agent-card-body')
      if (bodyEl) applyInlineRenderingToTextNodes(bodyEl, { userHandle, knownHandles })
    }
  }

  if (isActive(card.status)) {
    const spinnerEl = cardEl?.querySelector('.agent-card-spinner')
    if (spinnerEl) startSpinner(article, spinnerEl)
  }
}
