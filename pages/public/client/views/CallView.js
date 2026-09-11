/**
 * CallView.js — WebRTC call UI.
 *
 * Ported from islands/call.js with minimal changes. Manages local media,
 * tile grid, device picker, mini-bar, and all RTC signaling WS messages.
 *
 * Model events handled:
 *   channel-selected → update callChannelId context; show mini-bar if mid-call
 *
 * WS events handled directly (RTC is real-time critical — no model indirection):
 *   rtc.call_state, rtc.call, rtc.joined, rtc.peer_event, rtc.offer_event,
 *   rtc.answer_event, rtc.ice_event, rtc.call_end, rtc.left
 */

import { escHtml } from '../shared/messages.js'
import { RtcPeerManager } from '../rtc-peer-manager.js'
import { patchSettings } from '../settings-sync.js'
import { navigateTo } from '../router.js'
import * as Ev from '../model/events.js'

const DEVICES_KEY = 'devchitchat_devices'
const LAYOUT_KEY  = 'devchitchat_tile_layout'

export class CallView {
  #model
  #ws
  #root         // .chat-panel

  // DOM refs
  #tilePanelEl
  #tileGridEl
  #callStatusEl
  #callStatusInfo
  #callStatusAvatars
  #callControlsEl
  #peerCountEl
  #btnStartCall
  #btnJoinCall
  #btnLeaveCall
  #ctrlMic
  #ctrlCam
  #ctrlScreen
  #ctrlDevices
  #miniBarEl
  #miniBarName
  #miniBarMic
  #miniBarReturn
  #miniBarLeave

  // Call state
  #inCall     = false
  #callId     = null
  #selfPeerId = null
  #micMuted   = false
  #camOff     = true
  #screenSharing = false
  #pinnedPeerId  = null
  #callChannelId = null   // channel where the active call lives

  // Media streams
  #audioStream  = null
  #videoStream  = null
  #screenStream = null
  #iceServers   = [{ urls: 'stun:stun.l.google.com:19302' }]

  // Devices
  #availableDevices = { cameras: [], mics: [] }
  #activeCameraId   = null
  #activeMicId      = null
  #devicePickerEl   = null

  // RTC
  #rtcManager

  /**
   * @param {AppModel}   model
   * @param {WsClient}   ws
   * @param {HTMLElement} rootEl   — .chat-panel
   */
  constructor(model, ws, rootEl) {
    this.#model = model
    this.#ws    = ws
    this.#root  = rootEl

    this.#grabDomRefs()
    this.#buildRtcManager()
    this.#restoreLayoutState()
    this.#bindControls()
    this.#bindWsEvents()
    this.#bindModelEvents()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  #grabDomRefs() {
    const q = id => document.getElementById(id)
    this.#tilePanelEl       = q('tile-panel')
    this.#tileGridEl        = q('tile-grid')
    this.#callStatusEl      = q('call-status')
    this.#callStatusInfo    = q('call-status-info')
    this.#callStatusAvatars = q('call-status-avatars')
    this.#callControlsEl    = q('call-controls-bar')
    this.#peerCountEl       = q('call-peer-count')
    this.#btnStartCall      = q('btn-start-call')
    this.#btnJoinCall       = q('btn-join-call')
    this.#btnLeaveCall      = q('btn-leave-call')
    this.#ctrlMic           = q('ctrl-mic')
    this.#ctrlCam           = q('ctrl-cam')
    this.#ctrlScreen        = q('ctrl-screen')
    this.#ctrlDevices       = q('ctrl-devices')
    this.#miniBarEl         = q('call-mini-bar')
    this.#miniBarName       = q('mini-bar-channel-name')
    this.#miniBarMic        = q('mini-bar-mic')
    this.#miniBarReturn     = q('mini-bar-return')
    this.#miniBarLeave      = q('mini-bar-leave')
  }

  #buildRtcManager() {
    const ws = this.#ws
    this.#rtcManager = new RtcPeerManager({
      iceServers: this.#iceServers,
      getLocalStreams: () => ({
        audio:  this.#audioStream,
        video:  this.#videoStream,
        screen: this.#screenStream,
      }),
      handlers: {
        onOffer:        (peerId, sdp) => ws.send({ t: 'rtc.offer',  body: { call_id: this.#callId, to_peer_id: peerId, sdp } }),
        onAnswer:       (peerId, sdp) => ws.send({ t: 'rtc.answer', body: { call_id: this.#callId, to_peer_id: peerId, sdp } }),
        onIceCandidate: (peerId, candidate) => ws.send({ t: 'rtc.ice', body: { call_id: this.#callId, to_peer_id: peerId, candidate } }),
        onTrack:        (peerId, tileId, stream, label) => { this.#renderTile(tileId, stream, false, label); this.#ensureRemoteAudio(stream, peerId) },
        onAudio:        (peerId, stream) => this.#ensureRemoteAudio(stream, peerId),
        onPeerClosed:   (peerId) => {
          this.#tileGridEl?.querySelectorAll(`[data-peer^="${peerId}"]`).forEach(t => t.remove())
          document.querySelectorAll(`audio[data-peer-id="${peerId}"]`).forEach(a => { a.srcObject = null; a.remove() })
          this.#updateTileLayout()
        },
      },
    })
  }

  #restoreLayoutState() {
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
      if (saved.collapsed) this.#tilePanelEl?.classList.add('collapsed')
      if (saved.overlayRight && saved.overlayTop && this.#tilePanelEl) {
        this.#tilePanelEl.style.right = saved.overlayRight
        this.#tilePanelEl.style.top   = saved.overlayTop
      }
    } catch { /* ignore */ }
    this.#attachOverlayDrag(this.#tilePanelEl)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Button bindings
  // ─────────────────────────────────────────────────────────────────────────

  #bindControls() {
    // Mobile "back to sidebar" button
    this.#root.querySelector('.btn-back-mobile')?.addEventListener('click', () => {
      document.body.classList.add('sidebar-open')
    })

    this.#btnStartCall?.addEventListener('click', () => {
      const channelId = this.#model.currentChannelId
      this.#ws.send({ t: 'rtc.call_create', body: { channel_id: channelId, kind: 'mesh' } })
    })
    this.#btnJoinCall?.addEventListener('click', () => {
      if (this.#callId) this.#ws.send({ t: 'rtc.join', body: { call_id: this.#callId } })
    })
    this.#btnLeaveCall?.addEventListener('click', () => this.#leaveCall())
    this.#ctrlMic?.addEventListener('click', () => this.#toggleMic())
    this.#ctrlCam?.addEventListener('click', () => this.#toggleCamera())
    this.#ctrlScreen?.addEventListener('click', () => this.#toggleScreen())
    this.#ctrlDevices?.addEventListener('click', () => {
      this.#devicePickerEl?.classList.contains('open') ? this.#closePicker() : this.#openPicker()
    })
    this.#miniBarMic?.addEventListener('click', () => this.#toggleMic())
    this.#miniBarReturn?.addEventListener('click', () => {
      if (this.#callChannelId) {
        navigateTo(`${window.__BASE_PATH__ ?? ''}/channels/${this.#callChannelId}`, false)
      }
    })
    this.#miniBarLeave?.addEventListener('click', () => this.#leaveCall())

    document.getElementById('tile-panel-collapse')?.addEventListener('click', () => {
      const collapsed = this.#tilePanelEl?.classList.toggle('collapsed')
      try {
        const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...saved, collapsed: !!collapsed }))
      } catch { /* ignore */ }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WebSocket event bindings
  // ─────────────────────────────────────────────────────────────────────────

  #bindWsEvents() {
    const ws = this.#ws

    ws.on('rtc.call_state', body => {
      const channelId = this.#model.currentChannelId
      if (body.channel_id !== channelId) return
      if (!this.#inCall || body.channel_id === this.#callChannelId) {
        this.#callId = body.call_id
      }
      this.#updateCallStatusRow(body.call_id, body.count, body.users ?? [])
      this.#updateChannelBadge(body.count)
    })

    ws.on('rtc.call', body => {
      if (body.ice_servers?.length) {
        this.#iceServers = body.ice_servers
        this.#rtcManager.setIceServers(this.#iceServers)
      }
      this.#callId = body.call_id
      ws.send({ t: 'rtc.join', body: { call_id: body.call_id } })
    })

    ws.on('rtc.joined', async body => {
      const { call_id, peer_id, peers } = body
      if (body.ice_servers?.length) {
        this.#iceServers = body.ice_servers
        this.#rtcManager.setIceServers(this.#iceServers)
      }
      this.#selfPeerId   = peer_id
      this.#callId       = call_id
      this.#callChannelId = this.#model.currentChannelId
      this.#inCall       = true
      this.#showCallControls()
      this.#showTilePanel()
      this.#attachDeviceChangeListener()
      patchSettings({ last_channel_id: this.#callChannelId })

      await this.#startAudio()

      for (const peer of peers) {
        if (peer.peer_id !== peer_id) {
          this.#rtcManager.setDisplayName(peer.peer_id, peer.display_name)
          this.#rtcManager.ensurePeer(peer.peer_id)
          this.#rtcManager.negotiate(peer.peer_id)
        }
      }
    })

    ws.on('rtc.peer_event', ({ kind, peer }) => {
      if (kind === 'join' && peer.peer_id !== this.#selfPeerId) {
        this.#rtcManager.setDisplayName(peer.peer_id, peer.display_name)
        this.#rtcManager.ensurePeer(peer.peer_id)
      }
      if (kind === 'leave') {
        this.#rtcManager.closePeer(peer.peer_id)
      }
    })

    ws.on('rtc.offer_event', async ({ from_peer_id, sdp }) => {
      await this.#rtcManager.handleRemoteOffer(from_peer_id, this.#callId, sdp)
    })

    ws.on('rtc.answer_event', async ({ from_peer_id, sdp }) => {
      await this.#rtcManager.handleRemoteAnswer(from_peer_id, sdp)
    })

    ws.on('rtc.ice_event', async ({ from_peer_id, candidate }) => {
      await this.#rtcManager.handleIceCandidate(from_peer_id, candidate)
    })

    ws.on('rtc.call_end', ({ call_id }) => {
      if (call_id === this.#callId) this.#teardownCall()
    })

    ws.on('rtc.left', () => { /* server confirmed our leave */ })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model event bindings
  // ─────────────────────────────────────────────────────────────────────────

  #bindModelEvents() {
    this.#model.addEventListener(Ev.CHANNEL_SELECTED, e => {
      const { channelId } = e.detail
      if (this.#inCall && channelId !== this.#callChannelId) {
        this.#showMiniBar()
      } else if (channelId === this.#callChannelId) {
        this.#hideMiniBar()
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Call state UI
  // ─────────────────────────────────────────────────────────────────────────

  #updateCallStatusRow(activeCallId, count, users) {
    if (!this.#callStatusEl) return
    if (this.#inCall) {
      if (this.#peerCountEl) this.#peerCountEl.textContent = count > 1 ? `${count} in call` : ''
      this.#callStatusEl.hidden = true
      return
    }
    if (!activeCallId || count === 0) { this.#callStatusEl.hidden = true; return }
    this.#callStatusEl.hidden = false
    if (this.#callStatusInfo) this.#callStatusInfo.textContent = `${count} in call`
    if (this.#callStatusAvatars) {
      this.#callStatusAvatars.innerHTML = users.slice(0, 5).map(u =>
        `<span class="call-status-avatar" title="${escHtml(u.user_id)}">${escHtml(u.user_id.slice(0, 2).toUpperCase())}</span>`
      ).join('')
    }
  }

  #updateChannelBadge(count) {
    const channelId = this.#model.currentChannelId
    const li = document.querySelector(`.channel-link[data-channel-id="${channelId}"]`)?.closest('li')
    if (!li) return
    li.classList.toggle('call-active', count > 0)
    const badge = li.querySelector('.call-badge')
    if (badge) badge.textContent = count > 0 ? String(count) : ''
  }

  #showCallControls() {
    if (this.#callStatusEl) this.#callStatusEl.hidden = true
    this.#callControlsEl?.classList.add('active')
    if (this.#btnStartCall) this.#btnStartCall.hidden = true
  }

  #hideCallControls() {
    this.#callControlsEl?.classList.remove('active')
    if (this.#btnStartCall) this.#btnStartCall.hidden = false
  }

  #showTilePanel() {
    document.querySelector('.main-content')?.classList.add('has-call')
    this.#tilePanelEl?.classList.add('active')
  }

  #hideTilePanel() {
    document.querySelector('.main-content')?.classList.remove('has-call')
    this.#tilePanelEl?.classList.remove('active', 'collapsed')
  }

  #showMiniBar() {
    if (!this.#miniBarEl) return
    const meta = this.#model.currentChannelMeta
    if (this.#miniBarName) this.#miniBarName.textContent = meta.name ?? ''
    this.#miniBarEl.classList.add('active')
  }

  #hideMiniBar() { this.#miniBarEl?.classList.remove('active') }

  // ─────────────────────────────────────────────────────────────────────────
  // Local media
  // ─────────────────────────────────────────────────────────────────────────

  async #startAudio() {
    if (this.#audioStream) return
    try {
      const saved = this.#loadSavedDevices()
      this.#audioStream = await navigator.mediaDevices.getUserMedia({
        audio: saved.micId ? { deviceId: { ideal: saved.micId } } : true,
        video: false,
      })
      this.#activeMicId = this.#audioStream.getAudioTracks()[0]?.getSettings().deviceId ?? null
      this.#audioStream.getAudioTracks().forEach(t => { t.enabled = !this.#micMuted })
      await this.#refreshDevices()
      for (const peerId of this.#rtcManager.peerIds()) this.#rtcManager.negotiate(peerId)
    } catch {
      this.#micMuted = true
    }
  }

  async #toggleMic() {
    this.#micMuted = !this.#micMuted
    this.#audioStream?.getAudioTracks().forEach(t => { t.enabled = !this.#micMuted })
    if (this.#ctrlMic) this.#ctrlMic.textContent = this.#micMuted ? '🔇' : '🎙'
    if (this.#miniBarMic) this.#miniBarMic.textContent = this.#micMuted ? '🔇' : '🎙'
  }

  async #toggleCamera() {
    if (this.#videoStream) {
      this.#videoStream.getTracks().forEach(t => t.stop())
      this.#removeTile('local-cam')
      this.#videoStream = null
      this.#camOff = true
      for (const peerId of this.#rtcManager.peerIds()) this.#rtcManager.negotiate(peerId)
      if (this.#ctrlCam) this.#ctrlCam.textContent = '📷'
      return
    }
    try {
      const saved = this.#loadSavedDevices()
      const videoConstraint = saved.cameraId
        ? { deviceId: { ideal: saved.cameraId }, width: 640, height: 360 }
        : { width: 640, height: 360 }
      this.#videoStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false })
      this.#activeCameraId = this.#videoStream.getVideoTracks()[0]?.getSettings().deviceId ?? null
      this.#camOff = false
      const userHandle = this.#model.userHandle
      this.#renderTile('local-cam', this.#videoStream, true, `${userHandle ?? 'You'} (cam)`)
      this.#ws.send({ t: 'rtc.stream_publish', body: { call_id: this.#callId, stream: { kind: 'camera' } } })
      for (const peerId of this.#rtcManager.peerIds()) this.#rtcManager.negotiate(peerId)
      if (this.#ctrlCam) this.#ctrlCam.textContent = '📷✓'
    } catch { /* camera denied */ }
  }

  async #toggleScreen() {
    if (this.#screenStream) {
      this.#screenStream.getTracks().forEach(t => t.stop())
      this.#removeTile('local-screen')
      this.#screenStream = null
      this.#screenSharing = false
      for (const peerId of this.#rtcManager.peerIds()) this.#rtcManager.negotiate(peerId)
      if (this.#ctrlScreen) this.#ctrlScreen.textContent = '🖥'
      return
    }
    if (!navigator.mediaDevices?.getDisplayMedia) return
    try {
      this.#screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      this.#screenSharing = true
      const userHandle = this.#model.userHandle
      this.#renderTile('local-screen', this.#screenStream, true, `${userHandle ?? 'You'} (screen)`)
      this.#ws.send({ t: 'rtc.stream_publish', body: { call_id: this.#callId, stream: { kind: 'screen' } } })
      this.#screenStream.getVideoTracks()[0].addEventListener('ended', () => this.#toggleScreen())
      for (const peerId of this.#rtcManager.peerIds()) this.#rtcManager.negotiate(peerId)
      if (this.#ctrlScreen) this.#ctrlScreen.textContent = '🖥✓'
    } catch { /* user cancelled */ }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Remote audio
  // ─────────────────────────────────────────────────────────────────────────

  #ensureRemoteAudio(stream, peerId) {
    if (document.querySelector(`audio[data-peer-id="${peerId}"]`)) return
    const audio = document.createElement('audio')
    audio.autoplay = true
    audio.dataset.peerId = peerId
    audio.srcObject = stream
    document.body.appendChild(audio)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tile grid
  // ─────────────────────────────────────────────────────────────────────────

  #renderTile(tileId, stream, muted, label) {
    if (!this.#tileGridEl) return
    let tile = this.#tileGridEl.querySelector(`[data-peer="${tileId}"]`)
    if (!tile) {
      tile = document.createElement('div')
      tile.className = 'stream-tile'
      tile.dataset.peer = tileId
      tile.innerHTML = `
        <video autoplay playsinline controls ${muted ? 'muted' : ''}></video>
        <span class="tile-label">${escHtml(label)}</span>
        <div class="tile-capture-wrap">
          <button class="tile-pin" title="Move to top">⬆</button>
          <button class="tile-capture" title="Capture photo">📸</button>
          <div class="tile-capture-menu" hidden>
            <button class="tile-capture-opt" data-delay="0">0s</button>
            <button class="tile-capture-opt" data-delay="1">1s</button>
            <button class="tile-capture-opt" data-delay="3">3s</button>
            <button class="tile-capture-opt" data-delay="5">5s</button>
          </div>
        </div>
        <div class="tile-countdown" hidden></div>`
      tile.querySelector('video').addEventListener('click', e => e.stopPropagation())
      tile.querySelector('.tile-pin').addEventListener('click', e => { e.stopPropagation(); this.#pinTile(tileId) })
      const menu = tile.querySelector('.tile-capture-menu')
      tile.querySelector('.tile-capture').addEventListener('click', e => {
        e.stopPropagation()
        if (tile._captureTimer) { this.#startCapture(tile, label, 0); return }
        menu.hidden = !menu.hidden
      })
      menu.querySelectorAll('.tile-capture-opt').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation()
          menu.hidden = true
          this.#startCapture(tile, label, parseInt(btn.dataset.delay))
        })
      })
      this.#tileGridEl.appendChild(tile)
      this.#updateTileLayout()
    }
    if (stream) tile.querySelector('video').srcObject = stream
    return tile
  }

  #removeTile(tileId) {
    this.#tileGridEl?.querySelector(`[data-peer="${tileId}"]`)?.remove()
    this.#updateTileLayout()
  }

  #updateTileLayout() {
    if (!this.#tileGridEl) return
    const count = this.#tileGridEl.querySelectorAll('.stream-tile').length
    this.#tileGridEl.classList.toggle('avatars-only', count >= 5)
  }

  #pinTile(tileId) {
    if (this.#pinnedPeerId === tileId) {
      this.#tileGridEl?.classList.remove('pinned')
      this.#tileGridEl?.querySelectorAll('.stream-tile').forEach(t => t.classList.remove('pinned-tile'))
      this.#pinnedPeerId = null
    } else {
      this.#tileGridEl?.classList.add('pinned')
      this.#tileGridEl?.querySelectorAll('.stream-tile').forEach(t => t.classList.remove('pinned-tile'))
      this.#tileGridEl?.querySelector(`[data-peer="${tileId}"]`)?.classList.add('pinned-tile')
      this.#pinnedPeerId = tileId
    }
  }

  #captureFrame(tile, label) {
    const video = tile.querySelector('video')
    if (!video?.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `capture-${label.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}.png`
    a.click()
  }

  #startCapture(tile, label, delay) {
    const countdown = tile.querySelector('.tile-countdown')
    const captureBtn = tile.querySelector('.tile-capture')
    if (tile._captureTimer) {
      clearInterval(tile._captureTimer); tile._captureTimer = null
      countdown.hidden = true; captureBtn.textContent = '📸'; return
    }
    if (delay === 0) { this.#captureFrame(tile, label); return }
    let remaining = delay
    countdown.textContent = remaining; countdown.hidden = false; captureBtn.textContent = '✕'
    tile._captureTimer = setInterval(() => {
      remaining--
      if (remaining <= 0) {
        clearInterval(tile._captureTimer); tile._captureTimer = null
        countdown.hidden = true; captureBtn.textContent = '📸'; this.#captureFrame(tile, label)
      } else { countdown.textContent = remaining }
    }, 1000)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Device management
  // ─────────────────────────────────────────────────────────────────────────

  #loadSavedDevices() {
    try { return JSON.parse(localStorage.getItem(DEVICES_KEY) ?? '{}') } catch { return {} }
  }

  #saveDevices(patch) {
    localStorage.setItem(DEVICES_KEY, JSON.stringify({ ...this.#loadSavedDevices(), ...patch }))
  }

  async #refreshDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices()
    this.#availableDevices = {
      cameras: devices.filter(d => d.kind === 'videoinput'),
      mics:    devices.filter(d => d.kind === 'audioinput'),
    }
    return this.#availableDevices
  }

  #onDeviceChange() {
    this.#refreshDevices().then(({ cameras, mics }) => {
      const cameraGone = this.#activeCameraId && !cameras.find(d => d.deviceId === this.#activeCameraId)
      const micGone    = this.#activeMicId    && !mics.find(d => d.deviceId === this.#activeMicId)
      if (cameraGone || micGone) this.#showDeviceWarning(cameraGone ? 'camera' : 'mic')
      if (this.#devicePickerEl?.classList.contains('open')) this.#populatePicker()
    })
  }

  #attachDeviceChangeListener() {
    navigator.mediaDevices.addEventListener('devicechange', this.#onDeviceChange.bind(this))
  }

  #detachDeviceChangeListener() {
    navigator.mediaDevices.removeEventListener('devicechange', this.#onDeviceChange.bind(this))
  }

  async #openPicker() {
    if (!this.#devicePickerEl) this.#buildPicker()
    await this.#refreshDevices()
    this.#populatePicker()
    this.#devicePickerEl.classList.add('open')
  }

  #closePicker() {
    this.#devicePickerEl?._previewStream?.getTracks().forEach(t => t.stop())
    if (this.#devicePickerEl) this.#devicePickerEl._previewStream = null
    this.#devicePickerEl?.classList.remove('open')
  }

  #buildPicker() {
    const el = document.createElement('div')
    el.className = 'device-picker'
    el.innerHTML = `
      <div class="device-picker-row">
        <label>Camera</label><select id="dp-camera"></select>
        <video id="dp-preview" autoplay playsinline muted></video>
      </div>
      <div class="device-picker-row">
        <label>Microphone</label><select id="dp-mic"></select>
        <canvas id="dp-level" width="80" height="12"></canvas>
      </div>
      <div class="device-picker-footer">
        <button id="dp-cancel" class="btn-ghost" type="button">Cancel</button>
        <button id="dp-apply"  class="btn-primary" type="button">Switch</button>
      </div>`
    this.#callControlsEl?.after(el)
    this.#devicePickerEl = el

    el.querySelector('#dp-cancel').addEventListener('click', () => this.#closePicker())
    el.querySelector('#dp-apply').addEventListener('click', () => this.#applyPicker())

    el.querySelector('#dp-camera').addEventListener('change', async () => {
      el._previewStream?.getTracks().forEach(t => t.stop())
      el._previewStream = null
      const val = el.querySelector('#dp-camera').value
      if (!val) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: val } } })
        el.querySelector('#dp-preview').srcObject = stream
        el._previewStream = stream
      } catch { /* unavailable */ }
    })
  }

  #populatePicker() {
    const { cameras, mics } = this.#availableDevices
    const cameraSelect = this.#devicePickerEl?.querySelector('#dp-camera')
    const micSelect    = this.#devicePickerEl?.querySelector('#dp-mic')
    if (cameraSelect) cameraSelect.innerHTML = cameras
      .map(d => `<option value="${escHtml(d.deviceId)}"${d.deviceId === this.#activeCameraId ? ' selected' : ''}>${escHtml(d.label || 'Camera')}</option>`)
      .join('')
    if (micSelect) micSelect.innerHTML = mics
      .map(d => `<option value="${escHtml(d.deviceId)}"${d.deviceId === this.#activeMicId ? ' selected' : ''}>${escHtml(d.label || 'Microphone')}</option>`)
      .join('')
  }

  async #applyPicker() {
    const cameraId = this.#devicePickerEl?.querySelector('#dp-camera')?.value
    const micId    = this.#devicePickerEl?.querySelector('#dp-mic')?.value
    try {
      if (cameraId && cameraId !== this.#activeCameraId && this.#videoStream) await this.#switchCamera(cameraId)
      if (micId    && micId    !== this.#activeMicId)                          await this.#switchMic(micId)
      this.#ctrlDevices?.classList.remove('device-warning')
    } catch { /* leave current stream in place */ }
    this.#closePicker()
  }

  async #switchCamera(deviceId) {
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } })
    await this.#rtcManager.replaceTrack('camera', newStream.getVideoTracks()[0])
    this.#videoStream?.getTracks().forEach(t => t.stop())
    this.#videoStream = newStream
    this.#activeCameraId = deviceId
    this.#saveDevices({ cameraId: deviceId })
    const tile = this.#tileGridEl?.querySelector('[data-peer="local-cam"]')
    if (tile) tile.querySelector('video').srcObject = newStream
  }

  async #switchMic(deviceId) {
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } })
    const newTrack  = newStream.getAudioTracks()[0]
    newTrack.enabled = !this.#micMuted
    await this.#rtcManager.replaceTrack('audio', newTrack)
    this.#audioStream?.getTracks().forEach(t => t.stop())
    this.#audioStream = newStream
    this.#activeMicId = deviceId
    this.#saveDevices({ micId: deviceId })
  }

  #showDeviceWarning(kind) {
    const label = kind === 'camera' ? 'Camera' : 'Microphone'
    const toast = document.createElement('div')
    toast.className = 'device-warning-toast'
    toast.textContent = `${label} disconnected — click ⚙ to switch`
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 6000)
    this.#ctrlDevices?.classList.add('device-warning')
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Leave / teardown
  // ─────────────────────────────────────────────────────────────────────────

  #leaveCall() {
    if (!this.#inCall || !this.#callId) return
    this.#ws.send({ t: 'rtc.leave', body: { call_id: this.#callId } })
    this.#teardownCall()
  }

  #teardownCall() {
    this.#rtcManager.teardown()
    this.#audioStream?.getTracks().forEach(t => t.stop()); this.#audioStream = null
    this.#videoStream?.getTracks().forEach(t => t.stop()); this.#videoStream = null
    this.#screenStream?.getTracks().forEach(t => t.stop()); this.#screenStream = null
    document.querySelectorAll('audio[data-peer-id]').forEach(a => { a.srcObject = null; a.remove() })
    if (this.#tileGridEl) this.#tileGridEl.innerHTML = ''
    this.#updateTileLayout()
    this.#hideCallControls()
    this.#hideTilePanel()
    this.#hideMiniBar()
    this.#closePicker()
    this.#detachDeviceChangeListener()
    this.#ctrlDevices?.classList.remove('device-warning')
    this.#micMuted = false
    this.#camOff = true
    this.#screenSharing = false
    this.#inCall = false
    this.#selfPeerId = null
    this.#callChannelId = null
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Overlay drag (mobile)
  // ─────────────────────────────────────────────────────────────────────────

  #attachOverlayDrag(panel) {
    if (!panel) return
    if (window.matchMedia('(min-width: 1025px)').matches) return
    const header = panel.querySelector('.tile-panel-header')
    if (!header) return

    let startX, startY, startRight, startTop

    const onMove = e => {
      e.preventDefault()
      const clientX = e.touches ? e.touches[0].clientX : e.clientX
      const clientY = e.touches ? e.touches[0].clientY : e.clientY
      const dx = startX - clientX; const dy = clientY - startY
      panel.style.right = `${Math.max(0, Math.min(startRight + dx, window.innerWidth  - 60))}px`
      panel.style.top   = `${Math.max(0, Math.min(startTop  + dy, window.innerHeight - 60))}px`
    }

    const onEnd = () => {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup',   onEnd)
      document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend',  onEnd)
      try {
        const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...saved, overlayRight: panel.style.right, overlayTop: panel.style.top }))
      } catch { /* ignore */ }
    }

    header.addEventListener('mousedown', e => {
      startX = e.clientX; startY = e.clientY
      startRight = parseInt(panel.style.right) || 0; startTop = parseInt(panel.style.top) || 0
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onEnd)
    })

    header.addEventListener('touchstart', e => {
      e.preventDefault()
      startX = e.touches[0].clientX; startY = e.touches[0].clientY
      startRight = parseInt(panel.style.right) || 0; startTop = parseInt(panel.style.top) || 0
      document.addEventListener('touchmove', onMove, { passive: false }); document.addEventListener('touchend', onEnd)
    }, { passive: false })
  }
}
