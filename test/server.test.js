import { test, expect, describe, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initDb } from '../src/db/initDb.js'
import { createLogger } from '../src/util/logger.js'
import { ChatServer } from '../src/ws/ChatServer.js'
import { createServer } from '@devchitchat/index97'
import { init as initContext } from '../src/context.js'
import { join } from 'node:path'

let server

afterEach(() => { server?.stop() })

async function startServer() {
  const db = new Database(':memory:')
  initDb(db)
  const logger = createLogger()
  const chat = new ChatServer({ db, logger })

  initContext({
    db, logger,
    auth: chat.auth, hubService: chat.hubService, channelService: chat.channelService,
    messageService: chat.messageService, deliveryService: chat.deliveryService,
    searchService: chat.searchService, presenceService: chat.presenceService,
    signalingService: chat.signalingService,
  })

  server = await createServer({
    pagesDir: join(import.meta.dir, '../pages'),
    port: 0,
    dev: false,
    routes: {
      '/ws': (req, srv) => { if (srv.upgrade(req)) return; return new Response('upgrade required', { status: 426 }) }
    },
    websocket: chat.websocket,
  })

  chat.attachServer(server)
  return { server, chat, db }
}

describe('Server smoke tests', () => {
  test('GET /login returns 200', async () => {
    const { server } = await startServer()
    const res = await fetch(`http://localhost:${server.port}/login`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
  })

  test('GET / redirects unauthenticated users to /login', async () => {
    const { server } = await startServer()
    const res = await fetch(`http://localhost:${server.port}/`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('/login')
  })

  test('WebSocket hello handshake works', async () => {
    const { server } = await startServer()
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`)
    await new Promise(resolve => ws.addEventListener('open', resolve))

    const reply = new Promise(resolve => ws.addEventListener('message', e => resolve(JSON.parse(e.data))))
    ws.send(JSON.stringify({ v: 1, t: 'hello', id: 'test-1', ts: Date.now(), body: {} }))

    const msg = await reply
    expect(msg.t).toBe('hello_ack')
    expect(msg.ok).toBe(true)
    expect(msg.body.session.authenticated).toBe(false)

    ws.close()
  })

  test('WebSocket returns AUTH_REQUIRED for unauthenticated msg.send', async () => {
    const { server } = await startServer()
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`)
    await new Promise(resolve => ws.addEventListener('open', resolve))

    // Skip hello, send msg.send directly
    const reply = new Promise(resolve => ws.addEventListener('message', e => resolve(JSON.parse(e.data))))
    ws.send(JSON.stringify({ v: 1, t: 'msg.send', id: 'test-2', ts: Date.now(), body: {} }))

    const msg = await reply
    expect(msg.t).toBe('error')
    expect(msg.body.code).toBe('AUTH_REQUIRED')

    ws.close()
  })
})
