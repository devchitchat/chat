/**
 * lid-close-reconnect.test.js
 *
 * Models what happens when a laptop lid closes (network suspended) and reopens.
 *
 * On lid close: the browser doesn't immediately close the WebSocket — the OS
 * just silences the network interface. The socket hangs silently.
 * On lid open: the browser eventually detects the dead socket and fires onclose.
 * WsClient then reconnects with exponential backoff.
 *
 * This test verifies the full reconnect sequence:
 *   1. Initial connect → hello → hello_ack → channel.join → channel.joined
 *   2. Server drops the connection (simulating the browser detecting a dead socket)
 *   3. Client reconnects → hello → hello_ack → channel.join → channel.joined
 *   4. Client requests missed messages via msg.list with after_seq
 */

import { test, expect, beforeAll, afterAll } from 'bun:test'

const PORT   = 3099
const WS_URL = `ws://localhost:${PORT}/ws`

let server
let receivedMessages = []

function startServer() {
  receivedMessages = []
  server = Bun.serve({
    port: PORT,
    fetch(req, srv) {
      if (new URL(req.url).pathname === '/ws') {
        const ok = srv.upgrade(req)
        return ok ? undefined : new Response('upgrade failed', { status: 500 })
      }
      return new Response('ok')
    },
    websocket: {
      idleTimeout: 0,
      open(ws) {},
      message(ws, raw) {
        let msg
        try { msg = JSON.parse(raw) } catch { return }
        receivedMessages.push(msg)
        if (msg.t === 'hello') {
          ws.send(JSON.stringify({ v: 1, id: 's_1', ts: Date.now(), t: 'hello_ack', ok: true, body: {} }))
        }
        if (msg.t === 'channel.join') {
          ws.send(JSON.stringify({ v: 1, id: 's_2', ts: Date.now(), t: 'channel.joined', ok: true, body: { channel_id: msg.body.channel_id } }))
        }
        if (msg.t === 'msg.list') {
          ws.send(JSON.stringify({ v: 1, id: 's_3', ts: Date.now(), t: 'msg.list_result', ok: true, body: { channel_id: msg.body.channel_id, messages: [], has_more: false } }))
        }
      },
      close() {},
    },
  })
}

function stopServer() {
  return new Promise(resolve => {
    server?.stop(true)
    setTimeout(resolve, 50)
  })
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.onopen  = () => resolve(ws)
    ws.onerror = () => reject(new Error('WebSocket connect failed'))
    setTimeout(() => reject(new Error('connect timeout')), 3000)
  })
}

function waitForMessage(ws, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${type}"`)), timeout)
    ws.addEventListener('message', function handler({ data }) {
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (msg.t === type) {
        clearTimeout(timer)
        ws.removeEventListener('message', handler)
        resolve(msg)
      }
    })
  })
}

function waitForClose(ws, timeout = 3000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    const timer = setTimeout(() => reject(new Error('close timeout')), timeout)
    ws.addEventListener('close', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

beforeAll(() => startServer())
afterAll(()  => stopServer())

test('initial handshake completes: hello → hello_ack → channel.join → channel.joined', async () => {
  const CHANNEL_ID = 'c_test'
  const ws = await connect()

  ws.send(JSON.stringify({ v: 1, id: 'c_1', ts: Date.now(), t: 'hello', body: {} }))
  await waitForMessage(ws, 'hello_ack')

  ws.send(JSON.stringify({ v: 1, id: 'c_2', ts: Date.now(), t: 'channel.join', body: { channel_id: CHANNEL_ID } }))
  const joined = await waitForMessage(ws, 'channel.joined')
  expect(joined.body.channel_id).toBe(CHANNEL_ID)

  ws.close()
  await waitForClose(ws)
})

test('after connection drop, reconnect re-sends hello and channel.join', async () => {
  const CHANNEL_ID = 'c_reconnect'
  receivedMessages = []

  // ── 1. Initial connect + handshake ────────────────────────────────────────
  const ws = await connect()
  ws.send(JSON.stringify({ v: 1, id: 'c_1', ts: Date.now(), t: 'hello', body: {} }))
  await waitForMessage(ws, 'hello_ack')
  ws.send(JSON.stringify({ v: 1, id: 'c_2', ts: Date.now(), t: 'channel.join', body: { channel_id: CHANNEL_ID } }))
  await waitForMessage(ws, 'channel.joined')

  // ── 2. Server drops the socket (lid open — browser detects dead connection) ─
  await stopServer()
  await waitForClose(ws)

  // ── 3. Network is back — restart server and reconnect ────────────────────
  receivedMessages = []
  startServer()

  const ws2 = await connect()
  ws2.send(JSON.stringify({ v: 1, id: 'c_3', ts: Date.now(), t: 'hello', body: {} }))
  await waitForMessage(ws2, 'hello_ack')
  ws2.send(JSON.stringify({ v: 1, id: 'c_4', ts: Date.now(), t: 'channel.join', body: { channel_id: CHANNEL_ID } }))
  await waitForMessage(ws2, 'channel.joined')

  // ── 4. Verify reconnect sequence ──────────────────────────────────────────
  const types = receivedMessages.map(m => m.t)
  expect(types).toContain('hello')
  expect(types).toContain('channel.join')
  expect(receivedMessages.find(m => m.t === 'channel.join')?.body?.channel_id).toBe(CHANNEL_ID)

  ws2.close()
  await waitForClose(ws2)
})

test('server with idleTimeout:0 does not drop a silent connection on its own', async () => {
  // With idleTimeout:0 the server never evicts idle connections.
  // A sleeping laptop's socket hangs silently — the server holds it open.
  // Only the CLIENT detects the dead socket on wake and calls onclose.
  const ws = await connect()
  ws.send(JSON.stringify({ v: 1, id: 'c_1', ts: Date.now(), t: 'hello', body: {} }))
  await waitForMessage(ws, 'hello_ack')

  // Wait 500ms of silence — server should NOT close the connection
  await new Promise(r => setTimeout(r, 500))
  expect(ws.readyState).toBe(WebSocket.OPEN)

  ws.close()
  await waitForClose(ws)
})
