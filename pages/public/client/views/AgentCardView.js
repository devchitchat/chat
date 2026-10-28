/**
 * AgentCardView.js — renders and updates agent card messages.
 *
 * Agent cards are structured, live-updatable messages produced by the agent
 * during a session. They progress through status phases:
 *   thinking → working → streaming → done | error | interrupted
 *
 * makeAgentCardEl(message, ctx) — creates the initial <article> element.
 * updateAgentCard(article, message, ctx) — patches it in-place on msg.edited.
 *
 * Done state: compact receipt (title, chips, ask, expand links).
 * Active states: spinner, one live activity line, Activity expand link.
 * Error/interrupted: title in error tone, Activity expand link.
 *
 * Expand state (data-open-report, data-open-activity on article) survives
 * every 500 ms live edit because it lives on the article, not on innerHTML.
 *
 * ctx shape:
 *   userId        — current viewer's user ID
 *   userHandle    — current viewer's handle
 *   knownHandles  — for @mention rendering
 *   getAvatar     — uid → avatar data
 *   channelId     — current channel ID (needed for action-button dispatch)
 *   getHandle     — uid → @handle string (for action reply text)
 *   getDisplayName — uid → display name string (for answered-ask label)
 */

import { escHtml, applyAvatarToEl, applyInlineRenderingToTextNodes } from '../shared/messages.js'
import { wordCount, deriveTitle } from '../../../../src/core/receipt.js'
import { dispatch } from '../controllers/ChatController.js'

// ─────────────────────────────────────────────────────────────────────────────
// Braille spinner
// ─────────────────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const activeSpinners  = new WeakMap()  // article → intervalId
const interruptTimers = new WeakMap()  // article → timeoutId

// Cards still in an active state after this long are marked "interrupted".
const INTERRUPT_AFTER_MS = 5 * 60 * 1000

function startSpinner(article, spinnerEl) {
  if (activeSpinners.has(article)) return
  let frame = 0
  const id = setInterval(() => {
    spinnerEl.textContent = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
    frame++
  }, 100)
  activeSpinners.set(article, id)

  const interruptId = setTimeout(() => {
    if (!isActive(article.dataset.cardStatus)) return
    stopSpinner(article)
    article.dataset.cardStatus = 'interrupted'
    const labelEl = article.querySelector('.agent-card-status-label')
    if (labelEl) labelEl.textContent = 'interrupted'
  }, INTERRUPT_AFTER_MS)
  interruptTimers.set(article, interruptId)
}

function stopSpinner(article) {
  const id = activeSpinners.get(article)
  if (id != null) {
    clearInterval(id)
    activeSpinners.delete(article)
  }
  const interruptId = interruptTimers.get(article)
  if (interruptId != null) {
    clearTimeout(interruptId)
    interruptTimers.delete(article)
  }
}

function isActive(status) {
  return status === 'thinking' || status === 'working' || status === 'streaming'
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-icon helpers (shared by active and activity-section rendering)
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

// ─────────────────────────────────────────────────────────────────────────────
// Internal rendering helpers
// ─────────────────────────────────────────────────────────────────────────────

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

/** Full tool-call list (used inside the Activity expand section). */
function renderToolCallList(toolCalls) {
  if (!toolCalls?.length) return ''
  const rows = toolCalls.map(tc => {
    const icon    = toolIcon(tc.name)
    const summary = toolInputSummary(tc.name, tc.input)
    const label   = escHtml(summary || tc.name)
    const status  = tc.status ?? 'running'
    const mark = status === 'done'  ? '<span class="agent-card-tool-check"  aria-hidden="true">✓</span>'
               : status === 'error' ? '<span class="agent-card-tool-err"    aria-hidden="true">✗</span>'
               :                      '<span class="agent-card-tool-running" aria-hidden="true">…</span>'
    return `<div class="agent-card-tool" data-tool-status="${escHtml(status)}">
        <span class="agent-card-tool-icon" aria-hidden="true">${icon}</span>
        <code class="agent-card-tool-input">${label}</code>
        ${mark}
      </div>`
  }).join('')
  return `<div class="agent-card-tools">${rows}</div>`
}

/** One-line summary of the most-recent (last) tool call — shown while active. */
function renderLiveActivity(toolCalls) {
  if (!toolCalls?.length) return ''
  const last    = toolCalls[toolCalls.length - 1]
  const icon    = toolIcon(last.name)
  const summary = toolInputSummary(last.name, last.input)
  const label   = escHtml(summary || last.name)
  return `<div class="agent-card-live-activity" aria-live="polite">${icon} <code>${label}</code></div>`
}

/**
 * Render the expand links row.
 *
 * @param {{ reportWords, toolCount, openReport, openActivity, msgId, hasReport }} opts
 */
function renderExpandLinks({ reportWords, toolCount, openReport, openActivity, msgId, hasReport }) {
  const parts = []
  const idReport   = `report-${msgId}`
  const idActivity = `activity-${msgId}`

  if (hasReport) {
    const label = reportWords > 0 ? `Full report · ${reportWords} words` : 'Full report'
    const arrow = openReport ? '▴' : '▾'
    parts.push(
      `<button class="agent-card-link-btn" type="button"` +
      ` aria-expanded="${openReport}" aria-controls="${escHtml(idReport)}"` +
      ` data-section="report">${escHtml(label)} ${arrow}</button>`
    )
  }

  if (toolCount > 0) {
    const label = `Activity · ${toolCount} step${toolCount !== 1 ? 's' : ''}`
    const arrow = openActivity ? '▴' : '▾'
    parts.push(
      `<button class="agent-card-link-btn" type="button"` +
      ` aria-expanded="${openActivity}" aria-controls="${escHtml(idActivity)}"` +
      ` data-section="activity">${escHtml(label)} ${arrow}</button>`
    )
  }

  if (!parts.length) return ''
  return `<div class="agent-card-links">${parts.join('')}</div>`
}

/**
 * Render the receipt header (status dot + title).
 *
 * @param {string} title
 * @param {'ok'|'warn'|'error'|'neutral'} tone
 */
function renderReceiptHeader(title, tone = 'neutral') {
  return `<div class="agent-card-receipt-header">
    <span class="agent-card-receipt-dot agent-card-receipt-dot--${escHtml(tone)}" aria-hidden="true"></span>
    <span class="agent-card-receipt-title">${escHtml(title)}</span>
  </div>`
}

/**
 * Render the chips row.
 *
 * @param {{ text: string, tone: string }[]} chips
 */
function renderChips(chips) {
  if (!chips?.length) return ''
  const items = chips.map(c =>
    `<span class="agent-card-chip agent-card-chip--${escHtml(c.tone ?? 'neutral')}">${escHtml(c.text)}</span>`
  ).join('')
  return `<div class="agent-card-chips">${items}</div>`
}

/**
 * Render the ask row.
 *
 * @param {{ question, actions, answered? }} ask
 * @param {string} authorId   — card author's user ID
 * @param {string} authorHandle — card author's @handle (for reply text)
 * @param {string} viewerId   — current viewer's user ID
 * @param {string} channelId
 * @param {string} msgId
 * @param {function} getDisplayName — uid → string
 */
function renderAsk(ask, { authorId, authorHandle, viewerId, channelId, msgId, getDisplayName }) {
  if (!ask) return ''

  if (ask.answered) {
    const name = getDisplayName?.(ask.answered.by) ?? ask.answered.by
    return `<div class="agent-card-ask">
      <span class="agent-card-ask-answered">✓ ${escHtml(name)}: ${escHtml(ask.answered.action)}</span>
    </div>`
  }

  // Hide buttons if viewer is the card author (the agent itself), or if ask was disabled
  const isAuthor  = viewerId && viewerId === authorId
  const showBtns  = !isAuthor && !!authorHandle

  const questionHtml = `<span class="agent-card-ask-question">${escHtml(ask.question)}</span>`

  if (!showBtns) {
    return `<div class="agent-card-ask">${questionHtml}</div>`
  }

  const btns = ask.actions.map((action, i) => {
    const primary = i === 0 ? ' agent-card-ask-btn--primary' : ''
    return (
      `<button class="agent-card-ask-btn${primary}" type="button"` +
      ` data-action="${escHtml(action)}"` +
      ` data-author-handle="${escHtml(authorHandle)}"` +
      ` data-channel-id="${escHtml(channelId ?? '')}"` +
      ` data-msg-id="${escHtml(msgId ?? '')}"` +
      `>${escHtml(action)}</button>`
    )
  }).join('')

  return `<div class="agent-card-ask">
    ${questionHtml}
    <div class="agent-card-ask-actions">${btns}</div>
  </div>`
}

/**
 * Build the full card innerHTML for all card states.
 *
 * @param {object} card — card object from message
 * @param {string|null} renderedText — server-rendered HTML for the body
 * @param {object} opts
 *   msgId, openReport, openActivity, viewerId, channelId,
 *   getHandle, getDisplayName, authorId
 */
function renderCardContent(card, renderedText, {
  msgId        = '',
  openReport   = false,
  openActivity = false,
  viewerId     = null,
  channelId    = '',
  getHandle    = null,
  getDisplayName = null,
  authorId     = '',
} = {}) {
  const status    = card.status ?? 'thinking'
  const toolCalls = card.toolCalls ?? []
  const receipt   = card.receipt ?? null

  const idReport   = `report-${msgId}`
  const idActivity = `activity-${msgId}`

  // ── Active states (thinking / working / streaming) ─────────────────────────
  if (isActive(status)) {
    const liveActivity = (status === 'working' || status === 'streaming')
      ? renderLiveActivity(toolCalls)
      : ''

    // Streaming: show a short body preview (clamped by CSS)
    const previewHtml = (status === 'streaming' && card.body)
      ? `<div class="agent-card-body agent-card-body--streaming agent-card-body--preview">${escHtml(card.body)}</div>`
      : ''

    const expandLinks = renderExpandLinks({
      reportWords:  0,
      toolCount:    toolCalls.length,
      openReport:   false,
      openActivity,
      msgId,
      hasReport:    false,
    })

    const activitySection = toolCalls.length > 0
      ? `<div id="${escHtml(idActivity)}" class="agent-card-activity-section"${openActivity ? '' : ' hidden'}>
           ${renderToolCallList(toolCalls)}
         </div>`
      : ''

    return `
      <div class="agent-card-header">
        <span class="agent-card-spinner" aria-hidden="true">⠋</span>
        <span class="agent-card-status-label">${escHtml(_statusLabel(status))}</span>
      </div>
      ${liveActivity}
      ${previewHtml}
      ${expandLinks}
      ${activitySection}
    `
  }

  // ── Error / interrupted ────────────────────────────────────────────────────
  if (status === 'error' || status === 'interrupted') {
    const tone  = 'error'
    const title = card.body ? _firstLine(card.body) : (status === 'interrupted' ? 'Interrupted' : 'Error')
    const expandLinks = renderExpandLinks({
      reportWords: 0, toolCount: toolCalls.length,
      openReport: false, openActivity, msgId, hasReport: false,
    })
    const activitySection = toolCalls.length > 0
      ? `<div id="${escHtml(idActivity)}" class="agent-card-activity-section"${openActivity ? '' : ' hidden'}>
           ${renderToolCallList(toolCalls)}
         </div>`
      : ''

    return `
      <div class="agent-card-receipt">
        ${renderReceiptHeader(title, tone)}
        ${expandLinks}
        ${activitySection}
      </div>
    `
  }

  // ── Done state ─────────────────────────────────────────────────────────────
  // Title: from receipt, or derived from body.
  const body     = card.body ?? ''
  const words    = wordCount(body)
  const hasReport = !!body

  let title, tone, chips, note, ask
  if (receipt) {
    title = receipt.title
    tone  = receipt.tone  ?? 'ok'
    chips = receipt.chips ?? null
    note  = receipt.note  ?? null
    ask   = receipt.ask   ?? null
  } else {
    title = deriveTitle(body) || 'Done'
    tone  = 'ok'
    chips = null
    note  = null
    ask   = null
  }

  const authorHandle = getHandle?.(authorId) ?? null

  const expandLinks = renderExpandLinks({
    reportWords: words, toolCount: toolCalls.length,
    openReport, openActivity, msgId, hasReport,
  })

  // Report section (server-rendered markdown)
  const reportHtml = renderedText || (body ? escHtml(body) : '')
  const reportSection = hasReport
    ? `<div id="${escHtml(idReport)}" class="agent-card-report-section"${openReport ? '' : ' hidden'}>
         <div class="agent-card-body message-text">${reportHtml}</div>
       </div>`
    : ''

  // Activity section (tool calls + usage)
  const activitySection = toolCalls.length > 0
    ? `<div id="${escHtml(idActivity)}" class="agent-card-activity-section"${openActivity ? '' : ' hidden'}>
         ${renderToolCallList(toolCalls)}
         ${renderUsage(card.usage)}
       </div>`
    : ''

  return `
    <div class="agent-card-receipt">
      ${renderReceiptHeader(title, tone)}
      ${renderChips(chips)}
      ${note ? `<div class="agent-card-note">${escHtml(note)}</div>` : ''}
      ${renderAsk(ask, { authorId, authorHandle, viewerId, channelId, msgId, getDisplayName })}
      ${expandLinks}
    </div>
    ${reportSection}
    ${activitySection}
  `
}

function _statusLabel(status) {
  switch (status) {
    case 'thinking':  return 'thinking…'
    case 'working':   return 'working…'
    case 'streaming': return 'responding…'
    default:          return status
  }
}

function _firstLine(text) {
  return (text ?? '').split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 100) || 'Error'
}

// ─────────────────────────────────────────────────────────────────────────────
// Delegated interaction handler (attached once per card; survives innerHTML swaps)
// ─────────────────────────────────────────────────────────────────────────────

function attachCardInteractions(cardEl, article) {
  cardEl.addEventListener('click', e => {
    // ── Toggle expand links ────────────────────────────────────────────────
    const linkBtn = e.target.closest('.agent-card-link-btn')
    if (linkBtn) {
      const section = linkBtn.dataset.section
      if (section === 'report') {
        const open = article.dataset.openReport !== '1'
        article.dataset.openReport = open ? '1' : '0'
        linkBtn.setAttribute('aria-expanded', String(open))
        linkBtn.textContent = linkBtn.textContent.replace(/[▾▴]$/, open ? '▴' : '▾')
        const sectionEl = cardEl.querySelector('.agent-card-report-section')
        if (sectionEl) sectionEl.hidden = !open
      } else if (section === 'activity') {
        const open = article.dataset.openActivity !== '1'
        article.dataset.openActivity = open ? '1' : '0'
        linkBtn.setAttribute('aria-expanded', String(open))
        linkBtn.textContent = linkBtn.textContent.replace(/[▾▴]$/, open ? '▴' : '▾')
        const sectionEl = cardEl.querySelector('.agent-card-activity-section')
        if (sectionEl) sectionEl.hidden = !open
      }
      return
    }

    // ── Action buttons ─────────────────────────────────────────────────────
    const askBtn = e.target.closest('.agent-card-ask-btn')
    if (askBtn && !askBtn.disabled) {
      const action       = askBtn.dataset.action
      const authorHandle = askBtn.dataset.authorHandle
      const channelId    = askBtn.dataset.channelId
      const parentMsgId  = askBtn.dataset.msgId

      if (!action || !authorHandle || !channelId || !parentMsgId) return

      dispatch('send-thread-reply', {
        channelId,
        parentMsgId,
        text: `@${authorHandle} ${action}`,
      })

      // Disable all ask buttons immediately so double-clicks don't fire
      article.dataset.askDisabled = '1'
      for (const btn of cardEl.querySelectorAll('.agent-card-ask-btn')) {
        btn.disabled = true
      }
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a card <article> element for an agent message.
 *
 * @param {{ msg_id, seq, user_id, user_display_name, ts, text, rendered_text, edited_at, card }} message
 * @param {{ userId?, userHandle?, knownHandles?, getAvatar?, channelId?, getHandle?, getDisplayName? }} ctx
 */
export function makeAgentCardEl(message, {
  userId, userHandle, knownHandles, getAvatar,
  channelId = '', getHandle = null, getDisplayName = null,
} = {}) {
  const card   = message.card ?? { status: 'thinking', toolCalls: [], body: null, usage: null }
  const time   = new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const isSelf = userId != null && message.user_id === userId
  const msgId  = message.msg_id ?? ''

  const article = document.createElement('article')
  article.className          = 'message message--agent-card'
  article.dataset.seq        = message.seq
  article.dataset.msgId      = msgId
  article.dataset.userId     = message.user_id
  article.dataset.rawText    = message.text ?? ''
  article.dataset.editedAt   = message.edited_at ?? ''
  article.dataset.cardStatus = card.status ?? 'thinking'
  article.dataset.channelId  = channelId

  const contentHtml = renderCardContent(card, message.rendered_text, {
    msgId,
    openReport:    false,
    openActivity:  false,
    viewerId:      userId   ?? null,
    channelId,
    getHandle,
    getDisplayName,
    authorId:      message.user_id,
  })

  article.innerHTML = `
    <div class="msg-avatar" data-avatar-user="${escHtml(message.user_id)}" aria-hidden="true"></div>
    <span class="message-handle${isSelf ? '' : ' dm-trigger'}"
          data-user-id="${escHtml(message.user_id)}"
          title="${isSelf ? '' : 'Send a direct message'}">${escHtml(message.user_display_name ?? message.user_id)}</span>
    <time class="message-time" datetime="${message.ts}">${time}</time>
    <div class="agent-card" role="status" aria-live="polite" aria-label="Agent response">
      ${contentHtml}
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

  // Apply @mention rendering to a finished report section
  if (card.status === 'done') {
    const bodyEl = article.querySelector('.agent-card-body')
    if (bodyEl) applyInlineRenderingToTextNodes(bodyEl, { userHandle, knownHandles })
  }

  if (isActive(card.status)) {
    const spinnerEl = article.querySelector('.agent-card-spinner')
    if (spinnerEl) startSpinner(article, spinnerEl)
  }

  // Attach delegated interaction handler once; survives innerHTML replacements.
  const cardEl = article.querySelector('.agent-card')
  if (cardEl) attachCardInteractions(cardEl, article)

  return article
}

/**
 * Patch an existing agent card article in-place after a msg.edited event.
 * Preserves expand state (data-open-report, data-open-activity) and scroll position.
 *
 * @param {HTMLElement} article
 * @param {{ msg_id, text, rendered_text, edited_at, card }} message
 * @param {{ userHandle?, knownHandles?, channelId?, getHandle?, getDisplayName? }} ctx
 */
export function updateAgentCard(article, message, {
  userHandle, knownHandles,
  channelId = '', getHandle = null, getDisplayName = null,
} = {}) {
  const card = message.card ?? {}
  const msgId = message.msg_id ?? article.dataset.msgId ?? ''

  article.dataset.cardStatus = card.status ?? 'thinking'
  if (message.edited_at) article.dataset.editedAt = message.edited_at

  stopSpinner(article)

  const cardEl = article.querySelector('.agent-card')
  if (!cardEl) return

  // Preserve scroll of nearest scrollable ancestor across the innerHTML swap
  const scrollable = article.closest('[id="messages"]') ?? article.parentElement
  const prevScrollTop = scrollable?.scrollTop ?? 0

  // Read persisted expand state
  const openReport   = article.dataset.openReport   === '1'
  const openActivity = article.dataset.openActivity === '1'
  const viewerId     = article.closest('[data-viewer-id]')?.dataset.viewerId ?? null

  cardEl.innerHTML = renderCardContent(card, message.rendered_text, {
    msgId,
    openReport,
    openActivity,
    viewerId,
    channelId:     channelId || article.dataset.channelId || '',
    getHandle,
    getDisplayName,
    authorId:      article.dataset.userId ?? '',
  })

  if (scrollable) scrollable.scrollTop = prevScrollTop

  // Apply @mention and URL rendering to the completed body
  if (card.status === 'done') {
    const bodyEl = cardEl.querySelector('.agent-card-body')
    if (bodyEl) applyInlineRenderingToTextNodes(bodyEl, { userHandle, knownHandles })
  }

  if (isActive(card.status)) {
    const spinnerEl = cardEl.querySelector('.agent-card-spinner')
    if (spinnerEl) startSpinner(article, spinnerEl)
  }
}
