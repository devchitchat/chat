/**
 * call.js — combined chat + WebRTC island.
 *
 * Mounted on: <section class="chat-panel" island="/client/islands/call.js" …>
 *
 * Handles:
 *   - Chat (messages, composer) — same as the old chat.js island
 *   - WebRTC calls: start, join, leave, tile grid, mini-bar, sidebar badge
 *
 * WebRTC patterns ported from v1 RtcCallService:
 *   - negotiationInFlight / negotiationQueued per-peer serialisation
 *   - Pre-allocated transceiver slots (1 audio + 2 video: camera + screen)
 *   - replaceTrack() + direction toggle rather than addTrack() for renegotiation
 *   - waitForStableSignaling() before every offer
 *   - ICE candidate queue (pendingIceByPeer) until remote description is set
 *   - New joiner is offerer toward all existing peers; existing peers are answerers
 */
import { signal, effect, Context } from '@devchitchat/rdbljs'
import { WsClient } from '../ws.js'
import { patchSettings } from '../settings-sync.js'
import { navigateTo } from '../router.js'
import { escHtml, utcDateKey, formatDateLabel, makeDateSeparator, applyInlineRenderingToTextNodes, renderAttachment, makeMessageEl } from '../shared/messages.js'
import { RtcPeerManager } from '../rtc-peer-manager.js'

export default function CallIsland(root) {
  // ── Data from HTML ─────────────────────────────────────────────────────────
  let channelId   = root.dataset.id
  let channelKind = root.dataset.kind ?? 'text'
  const userId     = root.dataset.userId
  const userHandle = root.dataset.userHandle
  const seedSeq    = parseInt(root.dataset.seedSeq ?? '0', 10)
  let oldestSeq    = parseInt(root.dataset.seedFirstSeq ?? '0', 10)
  let loadingMore  = false

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const messages       = document.getElementById('messages')
  const sentinelEl     = document.getElementById('load-more-sentinel')
  const tilePanelEl   = document.getElementById('tile-panel')
  const tileGridEl    = document.getElementById('tile-grid')
  const callStatusEl  = document.getElementById('call-status')
  const callStatusInfo = document.getElementById('call-status-info')
  const callStatusAvatars = document.getElementById('call-status-avatars')
  const callControlsEl = document.getElementById('call-controls-bar')
  const peerCountEl   = document.getElementById('call-peer-count')
  const btnStartCall  = document.getElementById('btn-start-call')
  const btnJoinCall   = document.getElementById('btn-join-call')
  const btnLeaveCall  = document.getElementById('btn-leave-call')
  const ctrlMic       = document.getElementById('ctrl-mic')
  const ctrlCam       = document.getElementById('ctrl-cam')
  const ctrlScreen    = document.getElementById('ctrl-screen')
  const ctrlDevices   = document.getElementById('ctrl-devices')

  // Mini-bar (lives in sidebar footer — shared across channel navigations)
  const miniBarEl     = document.getElementById('call-mini-bar')
  const miniBarName   = document.getElementById('mini-bar-channel-name')
  const miniBarMic    = document.getElementById('mini-bar-mic')
  const miniBarReturn = document.getElementById('mini-bar-return')
  const miniBarLeave  = document.getElementById('mini-bar-leave')

  // ── WebSocket ──────────────────────────────────────────────────────────────
  const ws = new WsClient('/ws')

  // ── Chat signals ───────────────────────────────────────────────────────────
  const draft       = signal('')
  const channelName = signal(root.dataset.name ?? '')
  const channelTopic = signal(root.dataset.topic ?? '')
  let afterSeq = seedSeq

  // ── @mention picker state ──────────────────────────────────────────────────
  let channelMembers  = []   // [{ user_id, handle, display_name }] — non-bot users
  let channelBots     = []   // [{ user_id, handle, display_name }] — bot users
  let mentionFiltered = []   // current filtered subset
  let mentionStart    = -1   // index of '@' in textarea.value
  let mentionSelIdx   = 0    // keyboard-selected row

  // ── Call state ─────────────────────────────────────────────────────────────
  const inCall     = signal(false)
  const callIdSig  = signal(null)   // active call_id in this channel (may exist before we join)
  let callChannelId = null          // channel where the active call lives (may differ from channelId after navigation)
  const selfPeerId = signal(null)
  const micMuted   = signal(false)
  const camOff     = signal(false)
  const screenSharing = signal(false)
  let pinnedPeerId = null

  // ── Local media streams ────────────────────────────────────────────────────
  let audioStream  = null  // local mic
  let videoStream  = null  // local camera
  let screenStream = null  // local screen share
  let iceServers   = [{ urls: 'stun:stun.l.google.com:19302' }]

  // ── RTC peer manager ───────────────────────────────────────────────────────
  const rtcManager = new RtcPeerManager({
    iceServers,
    getLocalStreams: () => ({ audio: audioStream, video: videoStream, screen: screenStream }),
    handlers: {
      onOffer:        (peerId, sdp) => ws.send({ t: 'rtc.offer',  body: { call_id: callIdSig(), to_peer_id: peerId, sdp } }),
      onAnswer:       (peerId, sdp) => ws.send({ t: 'rtc.answer', body: { call_id: callIdSig(), to_peer_id: peerId, sdp } }),
      onIceCandidate: (peerId, candidate) => ws.send({ t: 'rtc.ice', body: { call_id: callIdSig(), to_peer_id: peerId, candidate } }),
      onTrack:        (peerId, tileId, stream, label) => { _renderTile(tileId, stream, false, label); _ensureRemoteAudio(stream, peerId) },
      onAudio:        (peerId, stream) => _ensureRemoteAudio(stream, peerId),
      onPeerClosed:   (peerId) => {
        tileGridEl?.querySelectorAll(`[data-peer^="${peerId}"]`).forEach(t => t.remove())
        document.querySelectorAll(`audio[data-peer-id="${peerId}"]`).forEach(a => { a.srcObject = null; a.remove() })
        _updateTileLayout()
      },
    },
  })

  // ── Device state ───────────────────────────────────────────────────────────
  const DEVICES_KEY = 'devchitchat_devices'
  let availableDevices = { cameras: [], mics: [] }
  let activeCameraId   = null
  let activeMicId      = null

  function loadSavedDevices() {
    try { return JSON.parse(localStorage.getItem(DEVICES_KEY) ?? '{}') } catch { return {} }
  }
  function saveDevices(patch) {
    localStorage.setItem(DEVICES_KEY, JSON.stringify({ ...loadSavedDevices(), ...patch }))
  }
  async function refreshDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices()
    availableDevices = {
      cameras: devices.filter(d => d.kind === 'videoinput'),
      mics:    devices.filter(d => d.kind === 'audioinput'),
    }
    return availableDevices
  }

  // ── Hydrate seed message attachments ──────────────────────────────────────
  // Seed messages are SSR'd without attachment HTML. Process data-attachments now.
  // Called on initial mount and again after each SPA navigation morph.
  function hydrateSeedMessages() {
    const articles = Array.from(messages.querySelectorAll('article.message'))
    let prevDateKey = null

    for (const article of articles) {
      if (article.dataset.hydrated) continue
      article.dataset.hydrated = '1'

      // Add dm-trigger to non-self sender handles; add … actions button to own messages
      const handle = article.querySelector('.message-handle[data-user-id]')
      if (handle && handle.dataset.userId !== userId) {
        handle.classList.add('dm-trigger')
        handle.title = 'Send a direct message'
      } else if (article.dataset.userId === userId && !article.querySelector('.btn-msg-actions')) {
        const btn = document.createElement('button')
        btn.className = 'btn-msg-actions btn-icon'
        btn.type = 'button'
        btn.title = 'Message actions'
        btn.textContent = '…'
        article.appendChild(btn)
      }

      // Apply inline rendering (URLs, @mentions) to server-rendered message text.
      // Walk text nodes instead of replacing innerHTML so that <a> tags already
      // rendered server-side (e.g. from markdown link syntax) are preserved.
      const textEl = article.querySelector('.message-text')
      if (textEl) applyInlineRenderingToTextNodes(textEl, { userHandle })

      // Inject attachment HTML for seed messages that have attachments_json
      const raw = article.dataset.attachments
      if (raw) {
        let attachments
        try { attachments = JSON.parse(raw) } catch { attachments = null }
        if (Array.isArray(attachments) && attachments.length > 0) {
          attachments.forEach(a => article.insertAdjacentHTML('beforeend', renderAttachment(a)))
        }
      }

      // Date separator before this article if date changed
      const ts = parseInt(article.querySelector('time')?.getAttribute('datetime') ?? '0', 10)
      if (ts) {
        const dateKey = utcDateKey(ts)
        if (prevDateKey && dateKey !== prevDateKey) {
          article.before(makeDateSeparator(dateKey))
        }
        prevDateKey = dateKey
      }
    }
  }
  hydrateSeedMessages()
  // Scroll to the bottom instantly on first load — requestAnimationFrame gives
  // the browser one layout cycle to settle flex heights before we measure
  // scrollHeight. behavior:'instant' bypasses scroll-behavior:smooth so there
  // is no visible animation from top to bottom on mount.
  requestAnimationFrame(() => messages.scrollTo({ top: messages.scrollHeight, behavior: 'instant' }))

  // ── Load-more sentinel + pagination ───────────────────────────────────────

  function showSentinel() { if (sentinelEl) sentinelEl.hidden = false }
  function hideSentinel() { if (sentinelEl) sentinelEl.hidden = true  }

  if (root.dataset.seedHasMore === 'true') showSentinel()

  const loadMoreObserver = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting || loadingMore || oldestSeq <= 1) return
    loadingMore = true
    ws.send({ t: 'msg.list', body: { channel_id: channelId, before_seq: oldestSeq } })
  }, { root: messages, threshold: 0.1 })

  if (sentinelEl) loadMoreObserver.observe(sentinelEl)

  // ── Date separator helpers ─────────────────────────────────────────────────
  // utcDateKey, formatDateLabel, makeDateSeparator imported from shared/messages.js

  function prependMessages(msgs) {
    const prevHeight = messages.scrollHeight
    const fragment   = document.createDocumentFragment()
    let   prevDate   = null

    const firstExisting = messages.querySelector('article.message')
    if (firstExisting) {
      const ts = parseInt(firstExisting.querySelector('time')?.getAttribute('datetime') ?? '0', 10)
      if (ts) prevDate = utcDateKey(ts)
    }

    for (const m of msgs) {
      const dateKey = utcDateKey(m.ts)
      if (prevDate && dateKey !== prevDate) {
        fragment.appendChild(makeDateSeparator(prevDate))
      }
      fragment.appendChild(makeMessageEl(m, { userId, userHandle }))
      prevDate = dateKey
    }

    // If last prepended message is different day from first existing, insert separator before existing
    if (firstExisting && prevDate) {
      const existingTs = parseInt(firstExisting.querySelector('time')?.getAttribute('datetime') ?? '0', 10)
      const existingDateKey = existingTs ? utcDateKey(existingTs) : null
      if (existingDateKey && prevDate !== existingDateKey) {
        messages.insertBefore(makeDateSeparator(existingDateKey), firstExisting)
      }
    }

    sentinelEl ? sentinelEl.after(fragment) : messages.prepend(fragment)
    messages.scrollTop += messages.scrollHeight - prevHeight
  }

  // ── @mention picker ────────────────────────────────────────────────────────

  const mentionPickerEl = document.createElement('div')
  mentionPickerEl.id        = 'mention-picker'
  mentionPickerEl.className = 'mention-picker'
  mentionPickerEl.hidden    = true
  root.querySelector('.composer')?.prepend(mentionPickerEl)

  function openPicker(filtered, start) {
    mentionFiltered = filtered
    mentionStart    = start
    mentionSelIdx   = 0
    renderPicker()
  }

  function closePicker() {
    mentionFiltered = []
    mentionStart    = -1
    mentionPickerEl.hidden = true
  }

  function renderPicker() {
    if (mentionFiltered.length === 0) { closePicker(); return }
    mentionPickerEl.innerHTML = mentionFiltered.map((m, i) => `
      <button class="mention-option${i === mentionSelIdx ? ' selected' : ''}"
              data-idx="${i}" type="button">
        <span class="mention-option-name">${escHtml(m.display_name || m.handle)}</span>
        <span class="mention-option-handle">@${escHtml(m.handle)}</span>
      </button>`).join('')
    mentionPickerEl.hidden = false
  }

  function selectMention(member) {
    if (!member) return
    const textarea = root.querySelector('#message-input')
    if (!textarea) return
    const cursor = textarea.selectionStart
    const val    = textarea.value
    const insert = `@${member.handle} `
    textarea.value = val.substring(0, mentionStart) + insert + val.substring(cursor)
    draft.set(textarea.value)
    const pos = mentionStart + insert.length
    textarea.setSelectionRange(pos, pos)
    closePicker()
    textarea.focus()
  }

  mentionPickerEl.addEventListener('mousedown', e => {
    // mousedown instead of click so the textarea doesn't lose focus first
    e.preventDefault()
    const btn = e.target.closest('.mention-option')
    if (!btn) return
    selectMention(mentionFiltered[parseInt(btn.dataset.idx, 10)])
  })

  function handleComposerInput(e) {
    const textarea = e.target
    const cursor   = textarea.selectionStart
    const before   = textarea.value.substring(0, cursor)
    // Match a bare @ or @partial-handle with no space, anchored to end of text-so-far
    const match    = before.match(/@([a-zA-Z0-9_.-]*)$/)
    if (!match) { closePicker(); return }
    const query    = match[1].toLowerCase()
    const start    = cursor - match[0].length
    const filtered = [...channelMembers, ...channelBots]
      .filter(m =>
        m.handle.toLowerCase().startsWith(query) ||
        (m.display_name ?? '').toLowerCase().startsWith(query)
      )
      .slice(0, 8)
    if (filtered.length === 0) { closePicker(); return }
    openPicker(filtered, start)
  }

  root.querySelector('#message-input')?.addEventListener('input', handleComposerInput)

  // ── Chat: connect + join channel ───────────────────────────────────────────

  ws.on('open', () => {
    ws.send({ t: 'hello', body: { client: 'devchitchat', resume: { session_token: null } } })
  })

  ws.on('hello_ack', () => {
    ws.send({ t: 'channel.join', body: { channel_id: channelId } })
  })

  ws.on('channel.joined', () => {
    if (afterSeq > 0) {
      ws.send({ t: 'msg.list', body: { channel_id: channelId, after_seq: afterSeq } })
    }
    if (channelMembers.length === 0) {
      ws.send({ t: 'user.list', body: {} })
      ws.send({ t: 'bot.list', body: {} })
    }
  })

  ws.on('user.list_result', ({ users }) => {
    channelMembers = (users ?? []).filter(m => m.handle)
  })

  ws.on('bot.list_result', ({ bots }) => {
    channelBots = (bots ?? []).filter(b => b.handle)
  })

  ws.on('msg.list_result', ({ messages: msgs, next_after_seq, has_more, direction }) => {
    if (direction === 'before') {
      if (msgs.length === 0) {
        hideSentinel()
        if (sentinelEl) loadMoreObserver.unobserve(sentinelEl)
        loadingMore = false
        return
      }
      prependMessages(msgs)
      if (msgs[0].seq < oldestSeq) oldestSeq = msgs[0].seq
      if (!has_more || oldestSeq <= 1) {
        hideSentinel()
        if (sentinelEl) loadMoreObserver.unobserve(sentinelEl)
      }
      loadingMore = false
      return
    }
    // after_seq catch-up path
    msgs.forEach(appendMessage)
    if (msgs.length) afterSeq = msgs[msgs.length - 1].seq
    else if (next_after_seq != null) afterSeq = next_after_seq
  })

  ws.on('msg.event', (body) => {
    if (body.channel_id !== channelId) return
    appendMessage(body)
    afterSeq = body.seq
  })

  ws.on('msg.edited', ({ msg_id, text, edited_at, rendered_text }) => {
    const article = messages.querySelector(`[data-msg-id="${msg_id}"]`)
    if (!article) return
    const textEl = article.querySelector('.message-text')
    if (textEl) textEl.innerHTML = sanitizeHtml(rendered_text)
    article.dataset.rawText = text
    article.dataset.editedAt = edited_at
    const timeEl = article.querySelector('.message-time')
    if (timeEl) {
      let editedSpan = timeEl.querySelector('.message-edited')
      if (!editedSpan) {
        editedSpan = document.createElement('span')
        editedSpan.className = 'message-edited'
        editedSpan.textContent = '(edited)'
        timeEl.appendChild(editedSpan)
      }
    }
  })

  ws.on('channel.updated', (body) => {
    if (body.channel?.channel_id !== channelId) return
    channelName.set(body.channel.name)
    channelTopic.set(body.channel.topic ?? '')
    document.title = `#${body.channel.name} — devchitchat`
  })

  // ── Chat: composer ─────────────────────────────────────────────────────────

  // Pending attachments: [{ upload_id, url, original_name, mime_type, size_bytes }]
  let pendingAttachments = []

  const composerEl = root.querySelector('.composer')
  const textareaEl = root.querySelector('#message-input')

  // Attachment chips container — injected above the textarea
  const chipsEl = document.createElement('div')
  chipsEl.className = 'attachment-chips'
  composerEl?.insertBefore(chipsEl, textareaEl)

  // Hidden file input
  const fileInputEl = document.createElement('input')
  fileInputEl.type = 'file'
  fileInputEl.multiple = true
  fileInputEl.style.display = 'none'
  fileInputEl.setAttribute('aria-hidden', 'true')
  composerEl?.appendChild(fileInputEl)

  // Attach-file button (paperclip)
  const btnAttachEl = document.createElement('button')
  btnAttachEl.type = 'button'
  btnAttachEl.className = 'btn-attach btn-icon'
  btnAttachEl.title = 'Attach file'
  btnAttachEl.setAttribute('aria-label', 'Attach file')
  btnAttachEl.innerHTML = '📎'
  // Insert before the send button
  const btnSendEl = composerEl?.querySelector('.btn-send')
  if (btnSendEl && composerEl) composerEl.insertBefore(btnAttachEl, btnSendEl)

  btnAttachEl.addEventListener('click', () => fileInputEl.click())
  fileInputEl.addEventListener('change', () => {
    uploadFiles([...fileInputEl.files])
    fileInputEl.value = ''
  })

  // Drag-and-drop onto the textarea
  let dropOverlayEl = null

  function ensureDropOverlay() {
    if (dropOverlayEl) return dropOverlayEl
    dropOverlayEl = document.createElement('div')
    dropOverlayEl.className = 'drop-overlay'
    dropOverlayEl.textContent = 'Drop to attach'
    composerEl?.appendChild(dropOverlayEl)
    return dropOverlayEl
  }

  composerEl?.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    ensureDropOverlay().hidden = false
  })

  composerEl?.addEventListener('dragleave', e => {
    if (composerEl.contains(e.relatedTarget)) return
    if (dropOverlayEl) dropOverlayEl.hidden = true
  })

  composerEl?.addEventListener('drop', e => {
    e.preventDefault()
    if (dropOverlayEl) dropOverlayEl.hidden = true
    const files = [...(e.dataTransfer.files ?? [])]
    if (files.length > 0) uploadFiles(files)
  })

  // Paste image from clipboard (screenshots, copied images)
  textareaEl?.addEventListener('paste', e => {
    const items = [...(e.clipboardData?.items ?? [])]
    const imageFiles = items
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => {
        const file = item.getAsFile()
        if (!file) return null
        if (!file.name) {
          const ext = item.type.split('/')[1] ?? 'png'
          return new File([file], `paste-${Date.now()}.${ext}`, { type: item.type })
        }
        return file
      })
      .filter(Boolean)
    if (imageFiles.length === 0) return
    e.preventDefault()
    uploadFiles(imageFiles)
  })

  async function uploadFiles(files) {
    for (const file of files) {
      await uploadOneFile(file, channelId)
    }
  }

  async function uploadOneFile(file, targetChannelId) {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('channel_id', targetChannelId)

    let res
    try {
      res = await fetch('/api/uploads', { method: 'POST', body: formData })
    } catch {
      showComposerError(`Upload failed: network error`)
      return null
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      showComposerError(`Upload failed: ${body.error ?? res.statusText}`)
      return null
    }

    const attachment = await res.json()
    pendingAttachments.push(attachment)
    renderChips()
    return attachment
  }

  function renderChips() {
    chipsEl.innerHTML = pendingAttachments.map((a, i) => `
      <span class="attachment-chip" data-index="${i}">
        <span class="attachment-chip-name">${escHtml(a.original_name)}</span>
        <button type="button" class="attachment-chip-remove" data-index="${i}" aria-label="Remove ${escHtml(a.original_name)}">×</button>
      </span>
    `).join('')
    chipsEl.hidden = pendingAttachments.length === 0
  }

  chipsEl.addEventListener('click', e => {
    const btn = e.target.closest('.attachment-chip-remove')
    if (!btn) return
    const idx = parseInt(btn.dataset.index, 10)
    pendingAttachments.splice(idx, 1)
    renderChips()
  })

  function showComposerError(msg) {
    const chip = document.createElement('span')
    chip.className = 'attachment-chip attachment-chip-error'
    chip.textContent = msg
    chipsEl.appendChild(chip)
    chipsEl.hidden = false
    setTimeout(() => chip.remove(), 5000)
  }

  // ── Urgent send ───────────────────────────────────────────────────────────
  const urgentMode = signal(false)
  const composerFooter = root.querySelector('.composer')

  function toggleUrgentMode() {
    urgentMode.set(!urgentMode())
    composerFooter?.classList.toggle('composer-urgent', urgentMode())
  }

  function sendMessage({ priority } = {}) {
    const text = draft().trim()
    if (!text && pendingAttachments.length === 0) return
    const resolvedPriority = priority ?? (urgentMode() ? 'now' : 'normal')
    ws.send({
      t: 'msg.send',
      body: {
        channel_id: channelId,
        text,
        client_msg_id: `local_${Date.now()}`,
        priority: resolvedPriority,
        attachments: pendingAttachments.map(a => ({
          upload_id: a.upload_id,
          url: a.url,
          filename: a.original_name,
          mime_type: a.mime_type,
          size_bytes: a.size_bytes,
        }))
      }
    })
    draft.set('')
    pendingAttachments = []
    renderChips()
  }

  function handleComposerKey(e) {
    if (!mentionPickerEl.hidden) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        mentionSelIdx = Math.min(mentionSelIdx + 1, mentionFiltered.length - 1)
        renderPicker()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        mentionSelIdx = Math.max(mentionSelIdx - 1, 0)
        renderPicker()
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectMention(mentionFiltered[mentionSelIdx])
        return
      }
      if (e.key === 'Escape') {
        closePicker()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const priority = e.ctrlKey || e.metaKey ? 'now' : undefined
      sendMessage({ priority })
    }
  }

  function appendMessage({ msg_id, seq, user_id, user_display_name, ts, text, attachments }) {
    if (messages.querySelector(`[data-msg-id="${msg_id}"]`)) return

    // Date separator if day changed
    const dateKey = utcDateKey(ts)
    const lastMsg = messages.querySelector('article.message:last-of-type')
    if (lastMsg) {
      const lastTs = parseInt(lastMsg.querySelector('time')?.getAttribute('datetime') ?? '0', 10)
      if (lastTs && utcDateKey(lastTs) !== dateKey) {
        messages.appendChild(makeDateSeparator(dateKey))
      }
    }

    const article = makeMessageEl({ msg_id, seq, user_id, user_display_name, ts, text, attachments }, { userId, userHandle })
    messages.appendChild(article)
    messages.scrollTop = messages.scrollHeight
  }

  // renderAttachment, formatBytes imported from shared/messages.js

  function sanitizeHtml(html) {
    return String(html ?? '').replaceAll('<script>', '').replaceAll('</script>', '')
  }

  // Delegated click: message sender name → open DM
  messages.addEventListener('click', e => {
    const handle = e.target.closest('.dm-trigger')
    if (!handle) return
    const targetUserId = handle.dataset.userId
    if (!targetUserId || targetUserId === userId) return
    ws.send({ t: 'dm.open', body: { target_user_id: targetUserId } })
  })

  // ── Inline edit ────────────────────────────────────────────────────────────

  function startInlineEdit(article) {
    if (article.querySelector('.message-edit-input')) return // already editing
    const textEl = article.querySelector('.message-text')
    if (!textEl) return
    const rawText = article.dataset.rawText ?? ''

    const textarea = document.createElement('textarea')
    textarea.className = 'message-edit-input'
    textarea.value = rawText
    textEl.replaceWith(textarea)
    textarea.focus()
    textarea.setSelectionRange(rawText.length, rawText.length)

    const toolbar = document.createElement('div')
    toolbar.className = 'message-edit-toolbar'
    toolbar.innerHTML = '<button class="btn-edit-save" type="button">Save</button><button class="btn-edit-cancel" type="button">Cancel</button>'
    textarea.after(toolbar)

    function cancel() {
      textarea.replaceWith(textEl)
      toolbar.remove()
    }

    function save() {
      const newText = textarea.value.trim()
      if (!newText) { cancel(); return }
      if (newText === rawText) { cancel(); return }
      // Optimistic: show new text immediately (unrendered), server will push rendered version via msg.edited
      textEl.textContent = newText
      cancel()
      ws.send({ t: 'msg.edit', body: { msg_id: article.dataset.msgId, channel_id: channelId, text: newText } })
    }

    toolbar.querySelector('.btn-edit-save').addEventListener('click', save)
    toolbar.querySelector('.btn-edit-cancel').addEventListener('click', cancel)
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() }
      if (e.key === 'Escape') cancel()
    })
  }

  // ── Context menu (desktop hover → … button) ────────────────────────────────

  let activeContextMenu = null

  function closeContextMenu() {
    if (activeContextMenu) { activeContextMenu.remove(); activeContextMenu = null }
  }

  function showContextMenu(article, anchorEl) {
    closeContextMenu()
    const isAuthor = article.dataset.userId === userId
    if (!isAuthor) return

    const menu = document.createElement('div')
    menu.className = 'msg-context-menu'
    const editBtn = document.createElement('button')
    editBtn.className = 'msg-context-menu-item'
    editBtn.type = 'button'
    editBtn.textContent = 'Edit'
    editBtn.addEventListener('click', () => { closeContextMenu(); startInlineEdit(article) })
    menu.appendChild(editBtn)

    document.body.appendChild(menu)
    activeContextMenu = menu

    const rect = anchorEl.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    let top = rect.bottom + window.scrollY + 4
    let left = rect.right + window.scrollX - menuRect.width
    if (left < 8) left = 8
    if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - 8 - menuRect.width
    menu.style.top = `${top}px`
    menu.style.left = `${left}px`
  }

  document.addEventListener('click', e => {
    if (activeContextMenu && !activeContextMenu.contains(e.target)) closeContextMenu()
  }, { capture: true })

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeContextMenu()
  })

  // Delegated click: … button → open context menu
  messages.addEventListener('click', e => {
    const btn = e.target.closest('.btn-msg-actions')
    if (!btn) return
    e.stopPropagation()
    const article = btn.closest('article.message')
    if (article) showContextMenu(article, btn)
  })


  ws.on('dm.opened', ({ channel_id, notify_only }) => {
    if (notify_only) return  // target user — sidebar handles the notification
    window.location.href = `/channels/${channel_id}`
  })

  // ── Call: rtc.call_state — drives "N in call" row + sidebar badge ──────────

  ws.on('rtc.call_state', (body) => {
    if (body.channel_id !== channelId) return
    // Don't overwrite the active call's ID when browsing a different channel —
    // callIdSig is what miniBarLeave uses to leave the call.
    if (!inCall() || body.channel_id === callChannelId) {
      callIdSig.set(body.call_id)
    }
    _updateCallStatusRow(body.call_id, body.count, body.users ?? [])
    _updateChannelBadge(body.count)
  })

  function _updateCallStatusRow(activeCallId, count, users) {
    if (!callStatusEl) return
    if (inCall()) {
      // Already in the call — just update peer count
      if (peerCountEl) peerCountEl.textContent = count > 1 ? `${count} in call` : ''
      callStatusEl.hidden = true
      return
    }
    if (!activeCallId || count === 0) {
      callStatusEl.hidden = true
      return
    }
    callStatusEl.hidden = false
    if (callStatusInfo) callStatusInfo.textContent = `${count} in call`
    if (callStatusAvatars) {
      callStatusAvatars.innerHTML = users.slice(0, 5).map(u =>
        `<span class="call-status-avatar" title="${escHtml(u.user_id)}">${escHtml(u.user_id.slice(0, 2).toUpperCase())}</span>`
      ).join('')
    }
  }

  function _updateChannelBadge(count) {
    const li = document.querySelector(`.channel-link[data-channel-id="${channelId}"]`)?.closest('li')
    if (!li) return
    li.classList.toggle('call-active', count > 0)
    const badge = li.querySelector('.call-badge')
    if (badge) badge.textContent = count > 0 ? String(count) : ''
  }

  // ── Call: start / join / leave ─────────────────────────────────────────────

  btnStartCall?.addEventListener('click', () => {
    ws.send({ t: 'rtc.call_create', body: { channel_id: channelId, kind: 'mesh' } })
  })

  btnJoinCall?.addEventListener('click', () => {
    const id = callIdSig()
    if (id) ws.send({ t: 'rtc.join', body: { call_id: id } })
  })

  btnLeaveCall?.addEventListener('click', leaveCall)

  function leaveCall() {
    const id = callIdSig()
    if (!inCall() || !id) return
    ws.send({ t: 'rtc.leave', body: { call_id: id } })
    _teardownCall()
  }

  // ── Call: WS message handlers ──────────────────────────────────────────────

  ws.on('rtc.call', (body) => {
    // Server confirmed call creation / found existing call — now join it
    if (body.ice_servers?.length) { iceServers = body.ice_servers; rtcManager.setIceServers(iceServers) }
    callIdSig.set(body.call_id)
    ws.send({ t: 'rtc.join', body: { call_id: body.call_id } })
  })

  ws.on('rtc.joined', async (body) => {
    const { call_id, peer_id, peers } = body
    if (body.ice_servers?.length) { iceServers = body.ice_servers; rtcManager.setIceServers(iceServers) }
    selfPeerId.set(peer_id)
    callIdSig.set(call_id)
    callChannelId = channelId
    inCall.set(true)
    _showCallControls()
    _showTilePanel()
    _attachDeviceChangeListener()
    patchSettings({ last_channel_id: channelId })

    // Start audio immediately; video is opt-in
    await _startAudio()

    // Cache display names for existing peers, then connect as offerer
    for (const peer of peers) {
      if (peer.peer_id !== peer_id) {
        rtcManager.setDisplayName(peer.peer_id, peer.display_name)
        rtcManager.ensurePeer(peer.peer_id)
        rtcManager.negotiate(peer.peer_id)
      }
    }
  })

  ws.on('rtc.peer_event', ({ call_id, kind, peer }) => {
    if (kind === 'join' && peer.peer_id !== selfPeerId()) {
      rtcManager.setDisplayName(peer.peer_id, peer.display_name)
      // Existing peer receives new joiner's event — create answerer connection
      // (new joiner will send us an offer)
      rtcManager.ensurePeer(peer.peer_id)
    }
    if (kind === 'leave') {
      rtcManager.closePeer(peer.peer_id)
    }
  })

  ws.on('rtc.offer_event', async ({ call_id, from_peer_id, sdp }) => {
    await rtcManager.handleRemoteOffer(from_peer_id, call_id, sdp)
  })

  ws.on('rtc.answer_event', async ({ call_id, from_peer_id, sdp }) => {
    await rtcManager.handleRemoteAnswer(from_peer_id, sdp)
  })

  ws.on('rtc.ice_event', async ({ from_peer_id, candidate }) => {
    await rtcManager.handleIceCandidate(from_peer_id, candidate)
  })

  ws.on('rtc.stream_event', () => {
    // No pre-tile creation here — tile IDs must match between this handler
    // (which uses kind: 'cam'/'screen') and ontrack (which uses transceiver.mid,
    // a number like '1' or '2'). The mismatch left orphaned empty tiles.
    // Tiles are created in ontrack once the actual stream track arrives.
  })

  ws.on('rtc.call_end', ({ call_id }) => {
    if (call_id === callIdSig()) _teardownCall()
  })

  ws.on('rtc.left', () => {
    // Server confirmed our leave
  })

  // ── Local media ────────────────────────────────────────────────────────────
  // Peer negotiation, transceiver slots, ICE queuing → RtcPeerManager

  async function _startAudio() {
    if (audioStream) return
    try {
      const saved = loadSavedDevices()
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: saved.micId ? { deviceId: { ideal: saved.micId } } : true,
        video: false,
      })
      activeMicId = audioStream.getAudioTracks()[0]?.getSettings().deviceId ?? null
      audioStream.getAudioTracks().forEach(t => { t.enabled = !micMuted() })
      await refreshDevices()  // labels now available after permission granted
      for (const peerId of rtcManager.peerIds()) rtcManager.negotiate(peerId)
    } catch {
      micMuted.set(true)
    }
  }

  async function toggleMic() {
    micMuted.set(!micMuted())
    audioStream?.getAudioTracks().forEach(t => { t.enabled = !micMuted() })
    if (ctrlMic) ctrlMic.textContent = micMuted() ? '🔇' : '🎙'
    if (miniBarMic) miniBarMic.textContent = micMuted() ? '🔇' : '🎙'
  }

  async function toggleCamera() {
    if (videoStream) {
      videoStream.getTracks().forEach(t => t.stop())
      _removeTile('local-cam')
      videoStream = null
      camOff.set(true)
      for (const peerId of rtcManager.peerIds()) rtcManager.negotiate(peerId)
      if (ctrlCam) ctrlCam.textContent = '📷'
      return
    }
    try {
      const saved = loadSavedDevices()
      const videoConstraint = saved.cameraId
        ? { deviceId: { ideal: saved.cameraId }, width: 640, height: 360 }
        : { width: 640, height: 360 }
      videoStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false })
      activeCameraId = videoStream.getVideoTracks()[0]?.getSettings().deviceId ?? null
      camOff.set(false)
      _renderTile('local-cam', videoStream, true, `${userHandle ?? 'You'} (cam)`)
      ws.send({ t: 'rtc.stream_publish', body: { call_id: callIdSig(), stream: { kind: 'camera' } } })
      for (const peerId of rtcManager.peerIds()) rtcManager.negotiate(peerId)
      if (ctrlCam) ctrlCam.textContent = '📷✓'
    } catch {
      // Camera denied
    }
  }

  async function toggleScreen() {
    if (screenStream) {
      screenStream.getTracks().forEach(t => t.stop())
      _removeTile('local-screen')
      screenStream = null
      screenSharing.set(false)
      for (const peerId of rtcManager.peerIds()) rtcManager.negotiate(peerId)
      if (ctrlScreen) ctrlScreen.textContent = '🖥'
      return
    }
    if (!navigator.mediaDevices?.getDisplayMedia) return
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      screenSharing.set(true)
      _renderTile('local-screen', screenStream, true, `${userHandle ?? 'You'} (screen)`)
      ws.send({ t: 'rtc.stream_publish', body: { call_id: callIdSig(), stream: { kind: 'screen' } } })
      screenStream.getVideoTracks()[0].addEventListener('ended', () => toggleScreen())
      for (const peerId of rtcManager.peerIds()) rtcManager.negotiate(peerId)
      if (ctrlScreen) ctrlScreen.textContent = '🖥✓'
    } catch { /* user cancelled */ }
  }

  // ── Audio element for remote peers ─────────────────────────────────────────

  function _ensureRemoteAudio(stream, peerId) {
    if (document.querySelector(`audio[data-peer-id="${peerId}"]`)) return
    const audio = document.createElement('audio')
    audio.autoplay = true
    audio.dataset.peerId = peerId
    audio.srcObject = stream
    document.body.appendChild(audio)
  }

  // ── Tile grid ──────────────────────────────────────────────────────────────

  function _captureFrame(tile, label) {
    const video = tile.querySelector('video')
    if (!video || !video.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `capture-${label.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}.png`
    a.click()
  }

  function _startCapture(tile, label, delay) {
    const countdown = tile.querySelector('.tile-countdown')
    const captureBtn = tile.querySelector('.tile-capture')
    if (tile._captureTimer) {
      clearInterval(tile._captureTimer)
      tile._captureTimer = null
      countdown.hidden = true
      captureBtn.textContent = '📸'
      return
    }
    if (delay === 0) { _captureFrame(tile, label); return }
    let remaining = delay
    countdown.textContent = remaining
    countdown.hidden = false
    captureBtn.textContent = '✕'
    tile._captureTimer = setInterval(() => {
      remaining--
      if (remaining <= 0) {
        clearInterval(tile._captureTimer)
        tile._captureTimer = null
        countdown.hidden = true
        captureBtn.textContent = '📸'
        _captureFrame(tile, label)
      } else {
        countdown.textContent = remaining
      }
    }, 1000)
  }

  function _renderTile(tileId, stream, muted, label) {
    if (!tileGridEl) return
    let tile = tileGridEl.querySelector(`[data-peer="${tileId}"]`)
    if (!tile) {
      tile = document.createElement('div')
      tile.className = 'stream-tile'
      tile.dataset.peer = tileId
      tile.innerHTML = `<video autoplay playsinline controls ${muted ? 'muted' : ''}></video><span class="tile-label">${escHtml(label)}</span><div class="tile-capture-wrap"><button class="tile-capture" title="Capture photo">📸</button><div class="tile-capture-menu" hidden><button class="tile-capture-opt" data-delay="0">0s</button><button class="tile-capture-opt" data-delay="1">1s</button><button class="tile-capture-opt" data-delay="3">3s</button><button class="tile-capture-opt" data-delay="5">5s</button></div></div><div class="tile-countdown" hidden></div>`
      tile.addEventListener('click', () => _pinTile(tileId))
      const menu = tile.querySelector('.tile-capture-menu')
      tile.querySelector('.tile-capture').addEventListener('click', e => {
        e.stopPropagation()
        if (tile._captureTimer) { _startCapture(tile, label, 0); return }
        menu.hidden = !menu.hidden
      })
      menu.querySelectorAll('.tile-capture-opt').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation()
          menu.hidden = true
          _startCapture(tile, label, parseInt(btn.dataset.delay))
        })
      })
      tileGridEl.appendChild(tile)
      _updateTileLayout()
    }
    if (stream) tile.querySelector('video').srcObject = stream
    return tile
  }

  function _removeTile(tileId) {
    tileGridEl?.querySelector(`[data-peer="${tileId}"]`)?.remove()
    _updateTileLayout()
  }

  function _updateTileLayout() {
    if (!tileGridEl) return
    const count = tileGridEl.querySelectorAll('.stream-tile').length
    tileGridEl.classList.toggle('avatars-only', count >= 5)
  }

  function _pinTile(tileId) {
    if (pinnedPeerId === tileId) {
      tileGridEl?.classList.remove('pinned')
      tileGridEl?.querySelectorAll('.stream-tile').forEach(t => t.classList.remove('pinned-tile'))
      pinnedPeerId = null
    } else {
      tileGridEl?.classList.add('pinned')
      tileGridEl?.querySelectorAll('.stream-tile').forEach(t => t.classList.remove('pinned-tile'))
      tileGridEl?.querySelector(`[data-peer="${tileId}"]`)?.classList.add('pinned-tile')
      pinnedPeerId = tileId
    }
  }

  // ── Device switching ───────────────────────────────────────────────────────

  async function switchCamera(deviceId) {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
    })
    const newTrack = newStream.getVideoTracks()[0]
    await rtcManager.replaceTrack('camera', newTrack)

    videoStream?.getTracks().forEach(t => t.stop())
    videoStream = newStream
    activeCameraId = deviceId
    saveDevices({ cameraId: deviceId })

    const localTile = tileGridEl?.querySelector('[data-peer="local-cam"]')
    if (localTile) localTile.querySelector('video').srcObject = newStream
  }

  async function switchMic(deviceId) {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
    })
    const newTrack = newStream.getAudioTracks()[0]
    newTrack.enabled = !micMuted()
    await rtcManager.replaceTrack('audio', newTrack)

    audioStream?.getTracks().forEach(t => t.stop())
    audioStream = newStream
    activeMicId = deviceId
    saveDevices({ micId: deviceId })
  }

  // ── Device change detection ────────────────────────────────────────────────

  function _onDeviceChange() {
    refreshDevices().then(({ cameras, mics }) => {
      const cameraGone = activeCameraId && !cameras.find(d => d.deviceId === activeCameraId)
      const micGone    = activeMicId    && !mics.find(d => d.deviceId === activeMicId)
      if (cameraGone || micGone) _showDeviceWarning(cameraGone ? 'camera' : 'mic')
      if (devicePickerEl?.classList.contains('open')) _populatePicker()
    })
  }

  function _attachDeviceChangeListener() {
    navigator.mediaDevices.addEventListener('devicechange', _onDeviceChange)
  }
  function _detachDeviceChangeListener() {
    navigator.mediaDevices.removeEventListener('devicechange', _onDeviceChange)
  }

  // ── Device picker ──────────────────────────────────────────────────────────

  let devicePickerEl = null

  function _buildPicker() {
    devicePickerEl = document.createElement('div')
    devicePickerEl.className = 'device-picker'
    devicePickerEl.innerHTML = `
      <div class="device-picker-row">
        <label>Camera</label>
        <select id="dp-camera"></select>
        <video id="dp-preview" autoplay playsinline muted></video>
      </div>
      <div class="device-picker-row">
        <label>Microphone</label>
        <select id="dp-mic"></select>
        <canvas id="dp-level" width="80" height="12"></canvas>
      </div>
      <div class="device-picker-footer">
        <button id="dp-cancel" class="btn-ghost" type="button">Cancel</button>
        <button id="dp-apply"  class="btn-primary" type="button">Switch</button>
      </div>
    `
    callControlsEl?.after(devicePickerEl)

    devicePickerEl.querySelector('#dp-cancel').addEventListener('click', _closePicker)
    devicePickerEl.querySelector('#dp-apply').addEventListener('click', _applyPicker)

    const cameraSelect = devicePickerEl.querySelector('#dp-camera')
    const previewVideo = devicePickerEl.querySelector('#dp-preview')

    cameraSelect.addEventListener('change', async () => {
      devicePickerEl._previewStream?.getTracks().forEach(t => t.stop())
      devicePickerEl._previewStream = null
      if (!cameraSelect.value) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: cameraSelect.value } },
        })
        previewVideo.srcObject = stream
        devicePickerEl._previewStream = stream
      } catch { /* camera unavailable */ }
    })
  }

  function _populatePicker() {
    const { cameras, mics } = availableDevices
    const cameraSelect = devicePickerEl?.querySelector('#dp-camera')
    const micSelect    = devicePickerEl?.querySelector('#dp-mic')
    if (cameraSelect) {
      cameraSelect.innerHTML = cameras
        .map(d => `<option value="${escHtml(d.deviceId)}"${d.deviceId === activeCameraId ? ' selected' : ''}>${escHtml(d.label || 'Camera')}</option>`)
        .join('')
    }
    if (micSelect) {
      micSelect.innerHTML = mics
        .map(d => `<option value="${escHtml(d.deviceId)}"${d.deviceId === activeMicId ? ' selected' : ''}>${escHtml(d.label || 'Microphone')}</option>`)
        .join('')
    }
  }

  async function _openPicker() {
    if (!devicePickerEl) _buildPicker()
    await refreshDevices()
    _populatePicker()
    devicePickerEl.classList.add('open')
  }

  function _closePicker() {
    devicePickerEl?._previewStream?.getTracks().forEach(t => t.stop())
    if (devicePickerEl) devicePickerEl._previewStream = null
    devicePickerEl?.classList.remove('open')
  }

  async function _applyPicker() {
    const cameraId = devicePickerEl?.querySelector('#dp-camera')?.value
    const micId    = devicePickerEl?.querySelector('#dp-mic')?.value
    try {
      if (cameraId && cameraId !== activeCameraId && videoStream) await switchCamera(cameraId)
      if (micId    && micId    !== activeMicId)                    await switchMic(micId)
      ctrlDevices?.classList.remove('device-warning')
    } catch { /* device unavailable — leave current stream in place */ }
    _closePicker()
  }

  ctrlDevices?.addEventListener('click', () => {
    devicePickerEl?.classList.contains('open') ? _closePicker() : _openPicker()
  })

  // ── Device warning toast ───────────────────────────────────────────────────

  function _showDeviceWarning(kind) {
    const label = kind === 'camera' ? 'Camera' : 'Microphone'
    const toast = document.createElement('div')
    toast.className = 'device-warning-toast'
    toast.textContent = `${label} disconnected — click ⚙ to switch`
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 6000)
    ctrlDevices?.classList.add('device-warning')
  }

  // ── Controls visibility ────────────────────────────────────────────────────

  function _showCallControls() {
    callStatusEl && (callStatusEl.hidden = true)
    callControlsEl?.classList.add('active')
    if (btnStartCall) btnStartCall.hidden = true
  }

  function _hideCallControls() {
    callControlsEl?.classList.remove('active')
    if (btnStartCall) btnStartCall.hidden = false
  }

  // ── Tile panel show / hide ─────────────────────────────────────────────────

  const LAYOUT_KEY = 'devchitchat_tile_layout'

  function _showTilePanel() {
    document.querySelector('.main-content')?.classList.add('has-call')
    tilePanelEl?.classList.add('active')
  }

  function _hideTilePanel() {
    document.querySelector('.main-content')?.classList.remove('has-call')
    tilePanelEl?.classList.remove('active')
    tilePanelEl?.classList.remove('collapsed')
  }

  // Restore collapse state from localStorage
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
    if (saved.collapsed) tilePanelEl?.classList.add('collapsed')
    if (saved.overlayRight && saved.overlayTop && tilePanelEl) {
      tilePanelEl.style.right = saved.overlayRight
      tilePanelEl.style.top   = saved.overlayTop
    }
  } catch { /* ignore */ }

  // Collapse toggle
  document.getElementById('tile-panel-collapse')?.addEventListener('click', () => {
    const collapsed = tilePanelEl?.classList.toggle('collapsed')
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...saved, collapsed: !!collapsed }))
    } catch { /* ignore */ }
  })

  // Overlay drag (mobile only)
  ;(function _attachOverlayDrag(panel) {
    if (!panel) return
    if (window.matchMedia('(min-width: 1025px)').matches) return

    const header = panel.querySelector('.tile-panel-header')
    if (!header) return

    let startX, startY, startRight, startTop

    function onMove(e) {
      e.preventDefault()  // stop page scroll while dragging the tile panel
      const clientX = e.touches ? e.touches[0].clientX : e.clientX
      const clientY = e.touches ? e.touches[0].clientY : e.clientY
      const dx = startX - clientX
      const dy = clientY - startY
      const newRight = Math.max(0, Math.min(startRight + dx, window.innerWidth  - 60))
      const newTop   = Math.max(0, Math.min(startTop  + dy, window.innerHeight - 60))
      panel.style.right = newRight + 'px'
      panel.style.top   = newTop   + 'px'
    }

    function onEnd() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onEnd)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend',  onEnd)
      try {
        const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({
          ...saved,
          overlayRight: panel.style.right,
          overlayTop:   panel.style.top,
        }))
      } catch { /* ignore */ }
    }

    header.addEventListener('mousedown', e => {
      startX = e.clientX; startY = e.clientY
      startRight = parseInt(panel.style.right) || 0
      startTop   = parseInt(panel.style.top)   || 0
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup',   onEnd)
    })

    header.addEventListener('touchstart', e => {
      e.preventDefault()  // prevent scroll from starting on the drag handle
      startX = e.touches[0].clientX; startY = e.touches[0].clientY
      startRight = parseInt(panel.style.right) || 0
      startTop   = parseInt(panel.style.top)   || 0
      document.addEventListener('touchmove', onMove, { passive: false })
      document.addEventListener('touchend',  onEnd)
    }, { passive: false })
  })(tilePanelEl)

  // ── Mini-bar (persists while navigating away during a call) ───────────────

  function _showMiniBar() {
    if (!miniBarEl) return
    if (miniBarName) miniBarName.textContent = channelName()
    miniBarEl.classList.add('active')
  }

  function _hideMiniBar() {
    miniBarEl?.classList.remove('active')
  }

  ctrlMic?.addEventListener('click', toggleMic)
  ctrlCam?.addEventListener('click', toggleCamera)
  ctrlScreen?.addEventListener('click', toggleScreen)
  miniBarMic?.addEventListener('click', toggleMic)

  miniBarReturn?.addEventListener('click', () => {
    if (callChannelId) navigateTo(`/channels/${callChannelId}`, false)
  })

  miniBarLeave?.addEventListener('click', () => {
    leaveCall()
  })

  // Show mini-bar when user navigates to a different channel while in a call
  document.addEventListener('channelnavigated', (e) => {
    if (inCall() && e.detail?.channelId !== channelId) {
      _showMiniBar()
    }
  })

  // SPA navigation: router morphed .chat-panel and dispatched this event.
  // Re-initialise chat state for the new channel without touching RTC.
  document.addEventListener('chatpanel:navigated', (e) => {
    const { channelId: newId, name, topic, kind, seedSeq: newSeedSeq, seedFirstSeq: newFirstSeq, seedHasMore: newHasMore } = e.detail
    if (newId === channelId) return   // same channel — nothing to do

    // Leave old channel subscription on the server
    ws.send({ t: 'channel.leave', body: { channel_id: channelId } })

    // Update local identity
    channelId = newId
    channelKind = kind
    channelName.set(name)
    channelTopic.set(topic)
    afterSeq = newSeedSeq

    // Reset pagination state for new channel
    oldestSeq   = newFirstSeq ?? 0
    loadingMore = false
    if (sentinelEl) {
      sentinelEl.hidden = !newHasMore
      if (newHasMore) loadMoreObserver.observe(sentinelEl)
      else            loadMoreObserver.unobserve(sentinelEl)
    }

    // Update browser chrome
    document.title = `#${name} — devchitchat`
    const textarea = root.querySelector('#message-input')
    if (textarea) textarea.placeholder = `Message in ${name}`

    // Hydrate attachments + dm-trigger on the freshly morphed seed articles
    hydrateSeedMessages()

    closePicker()

    // Join new channel — server responds with channel.joined + rtc.call_state.
    // channel.joined handler sends msg.list if afterSeq > 0, which will append
    // any messages that arrived after the seed snapshot.
    ws.send({ t: 'channel.join', body: { channel_id: channelId } })
  })

  // ── Teardown ───────────────────────────────────────────────────────────────

  function _teardownCall() {
    rtcManager.teardown()

    audioStream?.getTracks().forEach(t => t.stop()); audioStream = null
    videoStream?.getTracks().forEach(t => t.stop()); videoStream = null
    screenStream?.getTracks().forEach(t => t.stop()); screenStream = null

    document.querySelectorAll('audio[data-peer-id]').forEach(a => { a.srcObject = null; a.remove() })
    if (tileGridEl) tileGridEl.innerHTML = ''
    _updateTileLayout()
    _hideCallControls()
    _hideTilePanel()
    _hideMiniBar()
    _closePicker()
    _detachDeviceChangeListener()
    ctrlDevices?.classList.remove('device-warning')

    micMuted.set(false)
    camOff.set(false)
    screenSharing.set(false)
    inCall.set(false)
    selfPeerId.set(null)
    callChannelId = null
    pinnedPeerId = null
    activeCameraId = null
    activeMicId = null
  }

  // ── Mobile back button ─────────────────────────────────────────────────────

  root.querySelector('.btn-back-mobile')?.addEventListener('click', () => {
    document.body.classList.add('sidebar-open')
    patchSettings({ mobile_chat_open: false })
  })

  // ── Exports (rdbljs bindings) ──────────────────────────────────────────────

  return { draft, channelName, channelTopic, urgentMode, sendMessage, handleComposerKey, toggleUrgentMode }
}
