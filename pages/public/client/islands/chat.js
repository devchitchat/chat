/**
 * chat.js — rdbljs island for the message list and composer.
 *
 * Mounted on: <section island="/client/islands/chat.js" data-channel-id="..." ...>
 *
 * Responsibilities:
 *   - Connect to WebSocket, join channel
 *   - Append incoming msg.event messages to the list
 *   - Handle draft signal + send on Enter / button click
 *   - Search (debounced, via search.query)
 */
import { signal, computed, effect, Context } from '@devchitchat/rdbljs'
import { WsClient } from '../ws.js'
import { patchSettings } from '../settings-sync.js'

export default function ChatIsland(root) {
  const pageState = Context.read(root)?.pageState ?? {}
  const channelId = root.dataset.id
  const userId = root.dataset.userId
  const userHandle = root.dataset.userHandle
  const seedSeq = parseInt(root.dataset.seedSeq ?? '0', 10)

  const ws = new WsClient('/ws')
  const messages = document.getElementById('messages')

  // Record the channel the user is visiting
  patchSettings({ last_channel_id: channelId })

  // Signals
  const draft = signal('')
  const channelName = signal(root.dataset.name ?? '')
  const channelTopic = signal(root.dataset.topic ?? '')
  const searchOpen = signal(false)
  const searchQuery = signal('')
  const searchResults = signal([])

  let afterSeq = seedSeq

  // Connect + join channel
  ws.on('open', () => {
    ws.send({ t: 'hello', body: { client: 'devchitchat-v2', resume: { session_token: null } } })
  })

  ws.on('hello_ack', () => {
    ws.send({ t: 'channel.join', body: { channel_id: channelId } })
  })

  ws.on('channel.joined', () => {
    // Catch up on any messages missed during load
    if (afterSeq > 0) {
      ws.send({ t: 'msg.list', body: { channel_id: channelId, after_seq: afterSeq } })
    }
  })

  ws.on('msg.list_result', ({ messages: msgs, next_after_seq }) => {
    msgs.forEach(appendMessage)
    afterSeq = next_after_seq
  })

  ws.on('msg.event', (body) => {
    if (body.channel_id !== channelId) return
    appendMessage(body)
    afterSeq = body.seq
  })

  ws.on('channel.updated', (body) => {
    if (body.channel?.channel_id !== channelId) return
    channelName.set(body.channel.name)
    channelTopic.set(body.channel.topic ?? '')
    document.title = `#${body.channel.name} — devchitchat`
  })

  ws.on('search.result', ({ hits }) => {
    searchResults.set(hits)
  })

  // Search debounce
  let searchTimer = null
  effect(() => {
    const q = searchQuery()
    clearTimeout(searchTimer)
    if (!q.trim()) { searchResults.set([]); return }
    searchTimer = setTimeout(() => {
      ws.send({ t: 'search.query', body: { channel_id: channelId, q } })
    }, 300)
  })

  function appendMessage({ msg_id, seq, user_id, user_handle, ts, text }) {
    // Avoid duplicates (seed messages already in DOM)
    if (messages.querySelector(`[data-msg-id="${msg_id}"]`)) return
    const article = document.createElement('article')
    article.className = 'message'
    article.dataset.seq = seq
    article.dataset.msgId = msg_id
    const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    article.innerHTML = `
      <span class="message-handle">${escHtml(user_handle ?? user_id)}</span>
      <time class="message-time" datetime="${ts}">${time}</time>
      <p class="message-text">${escHtml(text)}</p>
    `
    messages.appendChild(article)
    messages.scrollTop = messages.scrollHeight
  }

  function sendMessage() {
    const text = draft().trim()
    if (!text) return
    ws.send({ t: 'msg.send', body: { channel_id: channelId, text, client_msg_id: `local_${Date.now()}` } })
    draft.set('')
  }

  function handleComposerKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  function toggleSearch() {
    searchOpen.set(!searchOpen())
    if (!searchOpen()) searchResults.set([])
  }

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  // ── Mobile navigation ──────────────────────────────────────────────────────

  // Back button: slide the message panel out, revealing the sidebar
  root.querySelector('.btn-back-mobile')?.addEventListener('click', () => {
    document.body.classList.add('sidebar-open')
    patchSettings({ mobile_chat_open: false })
  })

  return {
    draft,
    channelName,
    channelTopic,
    searchOpen,
    searchQuery,
    searchResults,
    sendMessage,
    handleComposerKey,
    toggleSearch
  }
}
