/**
 * RtcPeerManager — WebRTC peer connection lifecycle.
 *
 * Manages RTCPeerConnection instances, negotiation serialisation,
 * transceiver slot management, ICE candidate queuing, and inbound
 * stream resolution. Completely decoupled from WebSocket message
 * types, UI, and call state signals — all I/O is via callbacks.
 *
 * Patterns ported from v1 RtcCallService (significant debugging invested):
 *   - negotiationInFlight / negotiationQueued per-peer serialisation
 *   - Pre-allocated transceiver slots (1 audio + 2 video: cam + screen)
 *   - replaceTrack() + direction toggle rather than addTrack() for renegotiation
 *   - waitForStableSignaling() before every offer
 *   - ICE candidate queue (pendingIce) until remote description is set
 *   - New joiner is offerer toward all existing peers; existing peers are answerers
 *
 * @param {object} options
 * @param {RTCIceServer[]}             options.iceServers
 * @param {() => { audio, video, screen }} options.getLocalStreams  — reads current local MediaStreams from caller
 * @param {object}                     options.handlers
 * @param {(peerId, sdp) => void}      options.handlers.onOffer         — send rtc.offer via WS
 * @param {(peerId, sdp) => void}      options.handlers.onAnswer        — send rtc.answer via WS
 * @param {(peerId, candidate) => void} options.handlers.onIceCandidate — send rtc.ice via WS
 * @param {(peerId, tileId, stream, label) => void} options.handlers.onTrack — render a remote video tile
 * @param {(peerId, stream) => void}   options.handlers.onAudio         — ensure a remote audio element
 * @param {(peerId) => void}           options.handlers.onPeerClosed    — remove tiles + audio for this peer
 */
export class RtcPeerManager {
  #peerActors    = new Map()  // peerId → { pc }
  #displayNames  = new Map()  // peerId → display_name string
  #remoteStreams = new Map()  // peerId → Map<key, MediaStream>
  #pendingIce    = new Map()  // peerId → RTCIceCandidate[]
  #inFlight      = new Set()  // peerIds currently negotiating
  #queued        = new Set()  // peerIds with a queued renegotiation

  #iceServers
  #getLocalStreams
  #handlers

  constructor({ iceServers, getLocalStreams, handlers }) {
    this.#iceServers      = iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }]
    this.#getLocalStreams = getLocalStreams
    this.#handlers        = handlers
  }

  setIceServers(servers) {
    this.#iceServers = servers
  }

  setDisplayName(peerId, name) {
    if (name) this.#displayNames.set(peerId, name)
  }

  /** Iterate connected peer IDs — used by caller to renegotiate after local stream changes. */
  peerIds() {
    return this.#peerActors.keys()
  }

  /**
   * Ensure a peer actor exists, creating a new RTCPeerConnection if needed.
   * Safe to call for both offerer and answerer paths — does NOT pre-add
   * transceiver slots (that only happens in the offerer negotiation path).
   */
  ensurePeer(peerId) {
    if (this.#peerActors.has(peerId)) return this.#peerActors.get(peerId)

    const pc = new RTCPeerConnection({ iceServers: this.#iceServers })

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.#handlers.onIceCandidate(peerId, candidate)
    }

    pc.ontrack = (event) => {
      // If our transceiver is sendonly the remote peer is recvonly — they are
      // not sending into this slot (e.g. iPhone has no screen share).
      // Skip to avoid rendering an empty video element.
      if (event.transceiver?.direction === 'sendonly') return

      const stream = this.#getOrCreateInboundStream(event, peerId)
      if (!stream) return

      // Audio-only stream → just ensure an <audio> element exists
      if (stream.getVideoTracks().length === 0) {
        this.#handlers.onAudio(peerId, stream)
        return
      }

      // Video stream → render tile + ensure audio (video stream may carry audio track)
      const tileId = `${peerId}-${event.transceiver?.mid ?? 'cam'}`
      const label  = this.#displayNames.get(peerId) ?? peerId
      this.#handlers.onTrack(peerId, tileId, stream, label)
      this.#handlers.onAudio(peerId, stream)
    }

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        this.closePeer(peerId)
      }
    }

    const actor = { pc }
    this.#peerActors.set(peerId, actor)
    return actor
  }

  /** Close and remove a peer, then call onPeerClosed so caller can clean up UI. */
  closePeer(peerId) {
    const actor = this.#peerActors.get(peerId)
    if (actor) { actor.pc.close(); this.#peerActors.delete(peerId) }
    this.#remoteStreams.delete(peerId)
    this.#pendingIce.delete(peerId)
    this.#inFlight.delete(peerId)
    this.#queued.delete(peerId)
    this.#displayNames.delete(peerId)
    this.#handlers.onPeerClosed(peerId)
  }

  /**
   * Queue a negotiation for peerId, serialising concurrent attempts.
   * Safe to call multiple times — excess calls queue behind the in-flight one.
   */
  async negotiate(peerId) {
    if (this.#inFlight.has(peerId)) {
      this.#queued.add(peerId)
      return
    }
    this.#inFlight.add(peerId)
    try {
      do {
        this.#queued.delete(peerId)
        await this.#negotiateOnce(peerId)
      } while (this.#queued.has(peerId))
    } finally {
      this.#inFlight.delete(peerId)
    }
  }

  /**
   * Handle an incoming offer from a remote peer: set remote description,
   * drain queued ICE, attach local tracks, create and send an answer.
   */
  async handleRemoteOffer(peerId, callId, sdp) {
    const actor = this.ensurePeer(peerId)
    const pc    = actor.pc

    await pc.setRemoteDescription({ type: 'offer', sdp })
    await this.#drainIce(peerId, pc)
    await this.#attachLocalTracks(pc)

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    this.#handlers.onAnswer(peerId, answer.sdp)
  }

  /**
   * Handle an incoming answer from a remote peer: set remote description
   * and drain any queued ICE candidates.
   */
  async handleRemoteAnswer(peerId, sdp) {
    const actor = this.#peerActors.get(peerId)
    if (!actor) return
    await actor.pc.setRemoteDescription({ type: 'answer', sdp })
    await this.#drainIce(peerId, actor.pc)
  }

  /**
   * Handle an incoming ICE candidate. Queues it if the remote description
   * has not been set yet (race between offer/answer and ICE trickle).
   */
  async handleIceCandidate(peerId, candidate) {
    if (!candidate) return
    const actor = this.#peerActors.get(peerId)
    if (!actor || !actor.pc.remoteDescription) {
      if (!this.#pendingIce.has(peerId)) this.#pendingIce.set(peerId, [])
      this.#pendingIce.get(peerId).push(candidate)
      return
    }
    await actor.pc.addIceCandidate(candidate)
  }

  /**
   * Replace a single track slot in all active peer connections without
   * triggering a full renegotiation (used for device switching).
   * @param {'audio'|'camera'|'screen'} slotName
   * @param {MediaStreamTrack|null} track
   */
  async replaceTrack(slotName, track) {
    for (const { pc } of this.#peerActors.values()) {
      const slots = this.#getTransceiverSlots(pc)
      const transceiver = slots[slotName]
      if (transceiver?.sender) await transceiver.sender.replaceTrack(track)
    }
  }

  /** Close all peer connections and clear all state. */
  teardown() {
    for (const [, actor] of this.#peerActors) actor.pc.close()
    this.#peerActors.clear()
    this.#displayNames.clear()
    this.#remoteStreams.clear()
    this.#pendingIce.clear()
    this.#inFlight.clear()
    this.#queued.clear()
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  async #negotiateOnce(peerId) {
    const actor = this.#peerActors.get(peerId)
    if (!actor) return
    const pc = actor.pc

    const stable = await this.#waitForStable(pc)
    if (!stable) return  // timed out — don't attempt offer in bad state

    this.#ensureTransceiverSlots(pc)
    await this.#attachLocalTracks(pc)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.#handlers.onOffer(peerId, offer.sdp)
  }

  async #waitForStable(pc, timeoutMs = 3000) {
    if (!pc || pc.signalingState === 'stable') return true
    return new Promise(resolve => {
      const timer   = setTimeout(() => { cleanup(); resolve(false) }, timeoutMs)
      const handler = () => {
        if (pc.signalingState !== 'stable') return
        cleanup(); resolve(true)
      }
      const cleanup = () => { clearTimeout(timer); pc.removeEventListener('signalingstatechange', handler) }
      pc.addEventListener('signalingstatechange', handler)
    })
  }

  // ── Transceiver slot management ────────────────────────────────────────────
  // Pre-allocate 1 audio + 2 video transceivers (camera slot + screen slot).
  // Using replaceTrack() + direction toggle avoids creating new m= sections
  // on every track change, which prevents SDP renegotiation races.

  #ensureTransceiverSlots(pc) {
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

  #getTransceiverSlots(pc) {
    const all        = pc.getTransceivers()
    const audioSlot  = all.find(t => (t.receiver?.track?.kind ?? t.sender?.track?.kind) === 'audio') ??
                       all.find(t => !t.receiver?.track && !t.sender?.track) ?? null
    const videoSlots = all.filter(t => (t.receiver?.track?.kind ?? t.sender?.track?.kind) === 'video')
    const byMid      = all.filter(t => {
      const k = t.receiver?.track?.kind ?? t.sender?.track?.kind
      return k === 'video' || (!t.receiver?.track && !t.sender?.track)
    })
    return {
      audio:  audioSlot,
      camera: videoSlots[0] ?? byMid[0] ?? null,
      screen: videoSlots[1] ?? byMid[1] ?? null,
    }
  }

  async #attachLocalTracks(pc) {
    this.#ensureTransceiverSlots(pc)
    const slots = this.#getTransceiverSlots(pc)
    const { audio, video, screen } = this.#getLocalStreams()
    await Promise.all([
      this.#setTransceiverTrack(slots.audio,  audio?.getAudioTracks()[0]  ?? null),
      this.#setTransceiverTrack(slots.camera, video?.getVideoTracks()[0]  ?? null),
      this.#setTransceiverTrack(slots.screen, screen?.getVideoTracks()[0] ?? null),
    ])
  }

  async #setTransceiverTrack(transceiver, track) {
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

  // ── Inbound stream resolution (v1 RtcInboundStream pattern) ────────────────
  // Track events don't always carry an associated stream in all browsers.
  // Index by transceiver mid first, then stream id, synthesise if needed.

  #getOrCreateInboundStream(event, peerId) {
    if (!this.#remoteStreams.has(peerId)) this.#remoteStreams.set(peerId, new Map())
    const peerStreams = this.#remoteStreams.get(peerId)

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

    let stream = peerStreams.get(key) ??
      [...peerStreams.values()].find(s => s.getTracks().some(t => t.id === event.track.id)) ??
      null
    if (!stream) { stream = new MediaStream(); peerStreams.set(key, stream) }

    // Replace any stale track of the same kind
    stream.getTracks()
      .filter(t => t.kind === event.track.kind && t.id !== event.track.id)
      .forEach(t => { try { stream.removeTrack(t) } catch { /* ignore */ } })

    if (!stream.getTracks().some(t => t.id === event.track.id)) stream.addTrack(event.track)
    return stream
  }

  async #drainIce(peerId, pc) {
    const pending = this.#pendingIce.get(peerId) ?? []
    for (const c of pending) await pc.addIceCandidate(c)
    this.#pendingIce.delete(peerId)
  }
}
