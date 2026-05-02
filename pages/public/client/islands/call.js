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

export default function CallIsland(root) {
  // ── Data from HTML ─────────────────────────────────────────────────────────
  let channelId   = root.dataset.id
  let channelKind = root.dataset.kind ?? 'text'
  const userId     = root.dataset.userId
  const userHandle = root.dataset.userHandle
  const seedSeq    = parseInt(root.dataset.seedSeq ?? '0', 10)

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const messages      = document.getElementById('messages')
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

  // ── Call state ─────────────────────────────────────────────────────────────
  const inCall     = signal(false)
  const callIdSig  = signal(null)   // active call_id in this channel (may exist before we join)
  const selfPeerId = signal(null)
  const micMuted   = signal(false)
  const camOff     = signal(false)
  const screenSharing = signal(false)
  let pinnedPeerId = null

  // ── RTC state ──────────────────────────────────────────────────────────────
  const peerActors     = new Map()   // peerId → { pc, audioStream, videoStream, screenStream }
  const remoteStreamsByPeer = new Map() // peerId → Map<mid|streamId, MediaStream>
  const pendingIceByPeer = new Map() // peerId → RTCIceCandidate[]
  const negotiationInFlight = new Set()
  const negotiationQueued   = new Set()

  let audioStream  = null  // local mic
  let videoStream  = null  // local camera
  let screenStream = null  // local screen share
  let iceServers   = [{ urls: 'stun:stun.l.google.com:19302' }]

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

  // ── Chat: composer ─────────────────────────────────────────────────────────

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

  function appendMessage({ msg_id, seq, user_id, user_display_name, ts, text }) {
    if (messages.querySelector(`[data-msg-id="${msg_id}"]`)) return
    const article = document.createElement('article')
    article.className = 'message'
    article.dataset.seq = seq
    article.dataset.msgId = msg_id
    const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    article.innerHTML = `
      <span class="message-handle">${escHtml(user_display_name ?? user_id)}</span>
      <time class="message-time" datetime="${ts}">${time}</time>
      <p class="message-text">${escHtml(text)}</p>
    `
    messages.appendChild(article)
    messages.scrollTop = messages.scrollHeight
  }

  // ── Call: rtc.call_state — drives "N in call" row + sidebar badge ──────────

  ws.on('rtc.call_state', (body) => {
    if (body.channel_id !== channelId) return
    callIdSig.set(body.call_id)
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
    if (body.ice_servers?.length) iceServers = body.ice_servers
    callIdSig.set(body.call_id)
    ws.send({ t: 'rtc.join', body: { call_id: body.call_id } })
  })

  ws.on('rtc.joined', async (body) => {
    const { call_id, peer_id, peers } = body
    if (body.ice_servers?.length) iceServers = body.ice_servers
    selfPeerId.set(peer_id)
    callIdSig.set(call_id)
    inCall.set(true)
    _showCallControls()
    _showTilePanel()
    _attachDeviceChangeListener()
    patchSettings({ last_channel_id: channelId })

    // Start audio immediately; video is opt-in
    await _startAudio()

    // New joiner is offerer toward all existing peers
    for (const peer of peers) {
      if (peer.peer_id !== peer_id) {
        _ensurePeerActor(peer.peer_id)
        negotiatePeer(peer.peer_id)
      }
    }
  })

  ws.on('rtc.peer_event', ({ call_id, kind, peer }) => {
    if (kind === 'join' && peer.peer_id !== selfPeerId()) {
      // Existing peer receives new joiner's event — create answerer connection
      // (new joiner will send us an offer)
      _ensurePeerActor(peer.peer_id)
    }
    if (kind === 'leave') {
      _closePeer(peer.peer_id)
    }
  })

  ws.on('rtc.offer_event', async ({ call_id, from_peer_id, sdp }) => {
    const actor = _ensurePeerActor(from_peer_id)
    const pc = actor.pc

    await pc.setRemoteDescription({ type: 'offer', sdp })

    // Drain any ICE candidates that arrived before the remote description
    const pending = pendingIceByPeer.get(from_peer_id) ?? []
    for (const c of pending) await pc.addIceCandidate(c)
    pendingIceByPeer.delete(from_peer_id)

    await _attachLocalTracks(pc)

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    ws.send({ t: 'rtc.answer', body: { call_id, to_peer_id: from_peer_id, sdp: answer.sdp } })
  })

  ws.on('rtc.answer_event', async ({ call_id, from_peer_id, sdp }) => {
    const actor = peerActors.get(from_peer_id)
    if (!actor) return
    await actor.pc.setRemoteDescription({ type: 'answer', sdp })

    // Drain pending ICE
    const pending = pendingIceByPeer.get(from_peer_id) ?? []
    for (const c of pending) await actor.pc.addIceCandidate(c)
    pendingIceByPeer.delete(from_peer_id)
  })

  ws.on('rtc.ice_event', async ({ from_peer_id, candidate }) => {
    if (!candidate) return
    const actor = peerActors.get(from_peer_id)
    if (!actor || !actor.pc.remoteDescription) {
      // Queue until remote description is set
      if (!pendingIceByPeer.has(from_peer_id)) pendingIceByPeer.set(from_peer_id, [])
      pendingIceByPeer.get(from_peer_id).push(candidate)
      return
    }
    await actor.pc.addIceCandidate(candidate)
  })

  ws.on('rtc.stream_event', ({ peer_id, stream: streamMeta }) => {
    // Pre-create tile before WebRTC track arrives so the UI is responsive
    if (peer_id !== selfPeerId()) {
      const label = streamMeta?.kind === 'screen' ? `${peer_id} screen` : peer_id
      _renderTile(`${peer_id}-${streamMeta?.kind ?? 'cam'}`, null, false, label)
    }
  })

  ws.on('rtc.call_end', ({ call_id }) => {
    if (call_id === callIdSig()) _teardownCall()
  })

  ws.on('rtc.left', () => {
    // Server confirmed our leave
  })

  // ── Negotiation queue (v1 pattern) ─────────────────────────────────────────

  async function negotiatePeer(peerId) {
    if (negotiationInFlight.has(peerId)) {
      negotiationQueued.add(peerId)
      return
    }
    negotiationInFlight.add(peerId)
    try {
      do {
        negotiationQueued.delete(peerId)
        await negotiatePeerOnce(peerId)
      } while (negotiationQueued.has(peerId))
    } finally {
      negotiationInFlight.delete(peerId)
    }
  }

  async function negotiatePeerOnce(peerId) {
    const actor = peerActors.get(peerId)
    if (!actor) return
    const pc = actor.pc

    const stable = await waitForStableSignaling(pc)
    if (!stable) return  // timed out — don't attempt offer in bad state

    _ensureTransceiverSlots(pc)
    await _attachLocalTracks(pc)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    ws.send({ t: 'rtc.offer', body: { call_id: callIdSig(), to_peer_id: peerId, sdp: offer.sdp } })
  }

  async function waitForStableSignaling(pc, timeoutMs = 3000) {
    if (!pc || pc.signalingState === 'stable') return true
    return new Promise(resolve => {
      const timer = setTimeout(() => { cleanup(); resolve(false) }, timeoutMs)
      const handler = () => {
        if (pc.signalingState !== 'stable') return
        cleanup(); resolve(true)
      }
      const cleanup = () => { clearTimeout(timer); pc.removeEventListener('signalingstatechange', handler) }
      pc.addEventListener('signalingstatechange', handler)
    })
  }

  // ── Transceiver slot management (v1 pattern) ───────────────────────────────
  // Pre-allocate 1 audio + 2 video transceivers (camera slot + screen slot).
  // Using replaceTrack() + direction toggle avoids creating new m= sections
  // on every track change, which prevents SDP renegotiation races.

  function _ensureTransceiverSlots(pc) {
    const audio   = pc.getTransceivers().filter(t => t.receiver?.track?.kind === 'audio')
    const video   = pc.getTransceivers().filter(t => t.receiver?.track?.kind === 'video')
    const allVideo = pc.getTransceivers().filter(t => {
      const kind = t.receiver?.track?.kind ?? t.sender?.track?.kind
      return kind === 'video' || (!t.receiver?.track && !t.sender?.track && t.mid)
    })
    // Ensure at least 1 audio transceiver
    while (pc.getTransceivers().filter(t => {
      const k = t.receiver?.track?.kind ?? t.sender?.track?.kind
      return k === 'audio'
    }).length < 1) {
      pc.addTransceiver('audio', { direction: 'recvonly' })
    }
    // Ensure at least 2 video transceivers (camera + screen)
    const videoCount = pc.getTransceivers().filter(t => {
      const k = t.receiver?.track?.kind ?? t.sender?.track?.kind
      return k === 'video'
    }).length
    let added = videoCount
    while (added < 2) {
      pc.addTransceiver('video', { direction: 'recvonly' })
      added++
    }
  }

  function _getTransceiverSlots(pc) {
    const all = pc.getTransceivers()
    const audioSlot  = all.find(t => (t.receiver?.track?.kind ?? t.sender?.track?.kind) === 'audio') ??
                       all.find(t => !t.receiver?.track && !t.sender?.track) ?? null
    const videoSlots = all.filter(t => (t.receiver?.track?.kind ?? t.sender?.track?.kind) === 'video')
    // If no video kind is detectable yet, use index order
    const byMid = [...all].filter(t => {
      const k = t.receiver?.track?.kind ?? t.sender?.track?.kind
      return k === 'video' || (!t.receiver?.track && !t.sender?.track)
    })
    return {
      audio:  audioSlot,
      camera: videoSlots[0] ?? byMid[0] ?? null,
      screen: videoSlots[1] ?? byMid[1] ?? null,
    }
  }

  async function _attachLocalTracks(pc) {
    _ensureTransceiverSlots(pc)
    const slots = _getTransceiverSlots(pc)
    const audioTrack  = audioStream?.getAudioTracks()[0]  ?? null
    const cameraTrack = videoStream?.getVideoTracks()[0]  ?? null
    const screenTrack = screenStream?.getVideoTracks()[0] ?? null
    await Promise.all([
      _setTransceiverTrack(slots.audio,  audioTrack),
      _setTransceiverTrack(slots.camera, cameraTrack),
      _setTransceiverTrack(slots.screen, screenTrack),
    ])
  }

  async function _setTransceiverTrack(transceiver, track) {
    if (!transceiver?.sender) return
    if (transceiver.sender.track?.id === track?.id) return
    if (track) {
      if (transceiver.direction === 'recvonly' || transceiver.direction === 'inactive') {
        transceiver.direction = 'sendrecv'
      }
      await transceiver.sender.replaceTrack(track)
    } else {
      await transceiver.sender.replaceTrack(null)
      if (transceiver.direction === 'sendrecv' || transceiver.direction === 'sendonly') {
        transceiver.direction = 'recvonly'
      }
    }
  }

  // ── Peer actor management ──────────────────────────────────────────────────

  function _ensurePeerActor(peerId) {
    if (peerActors.has(peerId)) return peerActors.get(peerId)

    const pc = new RTCPeerConnection({ iceServers })
    _ensureTransceiverSlots(pc)

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        ws.send({ t: 'rtc.ice', body: { call_id: callIdSig(), to_peer_id: peerId, candidate } })
      }
    }

    pc.ontrack = (event) => {
      const stream = _getOrCreateInboundStream(event, peerId)
      if (!stream) return
      // Audio-only stream → just ensure an <audio> element exists
      if (stream.getVideoTracks().length === 0) {
        _ensureRemoteAudio(stream, peerId)
        return
      }
      // Video stream → render tile
      const tileId = `${peerId}-${event.transceiver?.mid ?? 'cam'}`
      _renderTile(tileId, stream, false, peerId)
      _ensureRemoteAudio(stream, peerId)
    }

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        _closePeer(peerId)
      }
    }

    const actor = { pc }
    peerActors.set(peerId, actor)
    return actor
  }

  function _closePeer(peerId) {
    const actor = peerActors.get(peerId)
    if (actor) { actor.pc.close(); peerActors.delete(peerId) }
    remoteStreamsByPeer.delete(peerId)
    pendingIceByPeer.delete(peerId)
    negotiationInFlight.delete(peerId)
    negotiationQueued.delete(peerId)
    // Remove all tiles for this peer
    tileGridEl?.querySelectorAll(`[data-peer^="${peerId}"]`).forEach(t => t.remove())
    document.querySelectorAll(`audio[data-peer-id="${peerId}"]`).forEach(a => { a.srcObject = null; a.remove() })
    _updateTileLayout()
  }

  // ── Inbound stream resolution (v1 RtcInboundStream pattern) ───────────────
  // Track events don't always carry an associated stream in all browsers.
  // Index by transceiver mid first, then stream id, synthesise if needed.

  function _getOrCreateInboundStream(event, peerId) {
    if (!remoteStreamsByPeer.has(peerId)) remoteStreamsByPeer.set(peerId, new Map())
    const peerStreams = remoteStreamsByPeer.get(peerId)

    const signaledStream = event.streams?.[0]
    if (signaledStream) {
      peerStreams.set(`stream:${signaledStream.id}`, signaledStream)
      const mid = event.transceiver?.mid
      if (mid != null) peerStreams.set(`mid:${mid}`, signaledStream)
      return signaledStream
    }

    if (!event.track) return null
    const mid = event.transceiver?.mid
    const key = mid != null ? `mid:${mid}` : `track:${event.track.kind}:${event.track.id}`

    let stream = peerStreams.get(key) ?? [...peerStreams.values()].find(s => s.getTracks().some(t => t.id === event.track.id)) ?? null
    if (!stream) { stream = new MediaStream(); peerStreams.set(key, stream) }

    // Replace any stale track of the same kind
    stream.getTracks().filter(t => t.kind === event.track.kind && t.id !== event.track.id).forEach(t => {
      try { stream.removeTrack(t) } catch { /* ignore */ }
    })
    if (!stream.getTracks().some(t => t.id === event.track.id)) stream.addTrack(event.track)
    return stream
  }

  // ── Local media ────────────────────────────────────────────────────────────

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
      for (const [peerId] of peerActors) negotiatePeer(peerId)
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
      for (const [peerId] of peerActors) negotiatePeer(peerId)
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
      for (const [peerId] of peerActors) negotiatePeer(peerId)
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
      for (const [peerId] of peerActors) negotiatePeer(peerId)
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
      for (const [peerId] of peerActors) negotiatePeer(peerId)
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

  function _renderTile(tileId, stream, muted, label) {
    if (!tileGridEl) return
    let tile = tileGridEl.querySelector(`[data-peer="${tileId}"]`)
    if (!tile) {
      tile = document.createElement('div')
      tile.className = 'stream-tile'
      tile.dataset.peer = tileId
      tile.innerHTML = `<video autoplay playsinline ${muted ? 'muted' : ''}></video><span class="tile-label">${escHtml(label)}</span>`
      tile.addEventListener('click', () => _pinTile(tileId))
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

    for (const { pc } of peerActors.values()) {
      const slots = _getTransceiverSlots(pc)
      if (slots.camera?.sender) await slots.camera.sender.replaceTrack(newTrack)
    }

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

    for (const { pc } of peerActors.values()) {
      const slots = _getTransceiverSlots(pc)
      if (slots.audio?.sender) await slots.audio.sender.replaceTrack(newTrack)
    }

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
      if (pickerEl?.classList.contains('open')) _populatePicker()
    })
  }

  function _attachDeviceChangeListener() {
    navigator.mediaDevices.addEventListener('devicechange', _onDeviceChange)
  }
  function _detachDeviceChangeListener() {
    navigator.mediaDevices.removeEventListener('devicechange', _onDeviceChange)
  }

  // ── Device picker ──────────────────────────────────────────────────────────

  let pickerEl = null

  function _buildPicker() {
    pickerEl = document.createElement('div')
    pickerEl.className = 'device-picker'
    pickerEl.innerHTML = `
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
    callControlsEl?.after(pickerEl)

    pickerEl.querySelector('#dp-cancel').addEventListener('click', _closePicker)
    pickerEl.querySelector('#dp-apply').addEventListener('click', _applyPicker)

    const cameraSelect = pickerEl.querySelector('#dp-camera')
    const previewVideo = pickerEl.querySelector('#dp-preview')

    cameraSelect.addEventListener('change', async () => {
      pickerEl._previewStream?.getTracks().forEach(t => t.stop())
      pickerEl._previewStream = null
      if (!cameraSelect.value) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: cameraSelect.value } },
        })
        previewVideo.srcObject = stream
        pickerEl._previewStream = stream
      } catch { /* camera unavailable */ }
    })
  }

  function _populatePicker() {
    const { cameras, mics } = availableDevices
    const cameraSelect = pickerEl?.querySelector('#dp-camera')
    const micSelect    = pickerEl?.querySelector('#dp-mic')
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
    if (!pickerEl) _buildPicker()
    await refreshDevices()
    _populatePicker()
    pickerEl.classList.add('open')
  }

  function _closePicker() {
    pickerEl?._previewStream?.getTracks().forEach(t => t.stop())
    if (pickerEl) pickerEl._previewStream = null
    pickerEl?.classList.remove('open')
  }

  async function _applyPicker() {
    const cameraId = pickerEl?.querySelector('#dp-camera')?.value
    const micId    = pickerEl?.querySelector('#dp-mic')?.value
    try {
      if (cameraId && cameraId !== activeCameraId && videoStream) await switchCamera(cameraId)
      if (micId    && micId    !== activeMicId)                    await switchMic(micId)
    } catch { /* device unavailable — leave current stream in place */ }
    _closePicker()
  }

  ctrlDevices?.addEventListener('click', () => {
    pickerEl?.classList.contains('open') ? _closePicker() : _openPicker()
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
  }

  function _hideCallControls() {
    callControlsEl?.classList.remove('active')
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
      startX = e.touches[0].clientX; startY = e.touches[0].clientY
      startRight = parseInt(panel.style.right) || 0
      startTop   = parseInt(panel.style.top)   || 0
      document.addEventListener('touchmove', onMove, { passive: true })
      document.addEventListener('touchend',  onEnd)
    }, { passive: true })
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
    window.location.href = `/channels/${channelId}`
  })

  miniBarLeave?.addEventListener('click', () => {
    leaveCall()
    _hideMiniBar()
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
    const { channelId: newId, name, topic, kind, seedSeq: newSeedSeq } = e.detail
    if (newId === channelId) return   // same channel — nothing to do

    // Leave old channel subscription on the server
    ws.send({ t: 'channel.leave', body: { channel_id: channelId } })

    // Update local identity
    channelId = newId
    channelKind = kind
    channelName.set(name)
    channelTopic.set(topic)
    afterSeq = newSeedSeq

    // Update browser chrome
    document.title = `#${name} — devchitchat`
    const textarea = root.querySelector('#message-input')
    if (textarea) textarea.placeholder = `Message in ${name}`

    // Join new channel — server responds with channel.joined + rtc.call_state.
    // channel.joined handler sends msg.list if afterSeq > 0, which will append
    // any messages that arrived after the seed snapshot.
    ws.send({ t: 'channel.join', body: { channel_id: channelId } })
  })

  // ── Teardown ───────────────────────────────────────────────────────────────

  function _teardownCall() {
    for (const [, actor] of peerActors) actor.pc.close()
    peerActors.clear()
    remoteStreamsByPeer.clear()
    pendingIceByPeer.clear()
    negotiationInFlight.clear()
    negotiationQueued.clear()

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
    pinnedPeerId = null
    activeCameraId = null
    activeMicId = null
  }

  // ── Mobile back button ─────────────────────────────────────────────────────

  root.querySelector('.btn-back-mobile')?.addEventListener('click', () => {
    document.body.classList.add('sidebar-open')
    patchSettings({ mobile_chat_open: false })
  })

  // ── Utility ────────────────────────────────────────────────────────────────

  function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  }

  // ── Exports (rdbljs bindings) ──────────────────────────────────────────────

  return { draft, channelName, channelTopic, sendMessage, handleComposerKey }
}
