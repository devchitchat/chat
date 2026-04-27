/**
 * WsClient — WebSocket wrapper with auto-reconnect (exponential backoff).
 *
 * Usage:
 *   const ws = new WsClient('/ws')
 *   ws.on('msg.event', (body) => { ... })
 *   ws.send({ t: 'hello', ... })
 */
export class WsClient extends EventTarget {
  #url
  #ws = null
  #reconnectDelay = 1000
  #maxDelay = 10000
  #msgId = 0
  #pending = []   // queued while disconnected

  constructor(path = '/ws') {
    super()
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.#url = `${proto}//${location.host}${path}`
    this.#connect()
  }

  #connect() {
    this.#ws = new WebSocket(this.#url)

    this.#ws.onopen = () => {
      this.#reconnectDelay = 1000
      this.dispatchEvent(new Event('open'))
      for (const msg of this.#pending) this.#ws.send(JSON.stringify(msg))
      this.#pending = []
    }

    this.#ws.onmessage = ({ data }) => {
      let msg
      try { msg = JSON.parse(data) } catch { return }
      this.dispatchEvent(Object.assign(new Event(msg.t), { msg }))
      this.dispatchEvent(Object.assign(new Event('*'), { msg }))
    }

    this.#ws.onclose = () => {
      this.dispatchEvent(new Event('close'))
      setTimeout(() => this.#connect(), this.#reconnectDelay)
      this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, this.#maxDelay)
    }

    this.#ws.onerror = () => { /* onclose fires after */ }
  }

  send(payload) {
    const msg = { v: 1, id: `c_${++this.#msgId}`, ts: Date.now(), ...payload }
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg))
    } else {
      this.#pending.push(msg)
    }
    return msg.id
  }

  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.msg?.body ?? e.msg, e.msg))
    return this
  }

  get ready() { return this.#ws?.readyState === WebSocket.OPEN }
}
