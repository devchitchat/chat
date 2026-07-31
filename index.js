#!/usr/bin/env bun
import { createServer, createRoutes } from '@devchitchat/index97'
import { openDatabase } from './src/db/openDb.js'
import { initDb } from './src/db/initDb.js'
import { runMigrations } from './src/db/runMigrations.js'
import { createLogger } from './src/util/logger.js'
import { ChatServer } from './src/ws/ChatServer.js'
import { init as initContext, sessionFromRequest } from './src/context.js'
import { UserSettingsService } from './src/services/UserSettingsService.js'
import { SqliteUserSettingsRepository } from './src/adapters/SqliteUserSettingsRepository.js'
import { UploadService } from './src/services/UploadService.js'
import { LocalFileStore } from './src/adapters/LocalFileStore.js'
import { SqliteUploadRepository } from './src/adapters/SqliteUploadRepository.js'

const CHAT_PAGES_DIR = import.meta.dir + '/pages'
const CHAT_PUBLIC_DIR = CHAT_PAGES_DIR + '/public'
const CHAT_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:"
const CHAT_PERMISSIONS_POLICY = 'camera=(self), microphone=(self), display-capture=(self)'

async function _setupServices(config = {}) {
  const {
    dbPath = process.env.DB_PATH ?? './data/chat.db',
    basePath = (process.env.BASE_PATH ?? '').replace(/\/$/, ''),
    dev = process.env.NODE_ENV !== 'production',
  } = config

  const p = path => `${basePath}${path}`

  const logger = createLogger()
  const db = openDatabase(dbPath)
  initDb(db)
  await runMigrations(db, { logger })

  const chat = new ChatServer({ db, logger })
  const userSettingsService = new UserSettingsService({ userSettingsRepo: new SqliteUserSettingsRepository({ db }) })
  const uploadService = new UploadService({
    uploadRepo: new SqliteUploadRepository({ db }),
    fileStore: new LocalFileStore(),
    channelService: chat.channelService,
  })
  chat.messageService.setUploadService(uploadService)

  initContext({
    auth: chat.auth,
    hubService: chat.hubService,
    channelService: chat.channelService,
    messageService: chat.messageService,
    deliveryService: chat.deliveryService,
    searchService: chat.searchService,
    presenceService: chat.presenceService,
    signalingService: chat.signalingService,
    botService: chat.botService,
    userSettingsService,
    uploadService,
    reactionService: chat.reactionService,
    logger,
  })

  return { chat, db, logger, p, basePath, dev }
}

/**
 * Return chat routes and websocket handler for embedding in an existing server.
 *
 * Use this when you want to run the chat app on the same port as another app.
 * Pass the returned routes and websocket to your own createServer() call, then
 * call onServerReady() with the server instance once it is created.
 *
 * @example
 * import { createServer } from '@devchitchat/index97'
 * import { setup as setupChat } from '@devchitchat/chat'
 *
 * const chat = await setupChat({ basePath: '/chat', dbPath: './data/chat.db' })
 *
 * const server = await createServer({
 *   pagesDir: new URL('./pages', import.meta.url).pathname,
 *   port: 3000,
 *   routes: chat.routes,
 *   websocket: chat.websocket,
 * })
 *
 * chat.onServerReady(server)
 *
 * @param {object} config
 * @param {string}  [config.basePath]  - URL prefix for all chat routes (e.g. '/chat')
 * @param {string}  [config.dbPath]    - Path to the SQLite database file
 * @param {boolean} [config.dev]       - Enable dev mode
 * @returns {Promise<{ routes: object, websocket: object, onServerReady: Function }>}
 */
export async function setup(config = {}) {
  const { chat, logger, p, basePath, dev } = await _setupServices(config)

  // Discover and prefix all file-based chat page routes
  const routes = await createRoutes({
    pagesDir: CHAT_PAGES_DIR,
    prefix: basePath,
    dev,
    csp: CHAT_CSP,
    permissionsPolicy: CHAT_PERMISSIONS_POLICY,
  })

  // Explicit protocol routes
  routes[p('/ws')] = (req, server) => {
    const session = sessionFromRequest(req)
    if (server.upgrade(req, {
      data: session ? { userId: session.user.user_id, sessionId: session.session_id, displayName: session.user.display_name } : {}
    })) return
    return new Response('WebSocket upgrade required', { status: 426 })
  }

  routes[p('/vendor/rdbl.js')] = () =>
    new Response(Bun.file(new URL(import.meta.resolve('@devchitchat/rdbljs/src/rdbl.js'))), {
      headers: { 'Content-Type': 'text/javascript' },
    })

  routes[p('/sw.js')] = () => new Response(
    Bun.file(CHAT_PAGES_DIR + '/public/sw.js'),
    { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Service-Worker-Allowed': `${basePath}/`, 'Cache-Control': 'no-cache, no-store' } }
  )

  routes[p('/manifest.json')] = () => new Response(
    JSON.stringify({
      name: 'devchitchat', short_name: 'devchitchat',
      start_url: `${basePath}/`, scope: `${basePath}/`,
      display: 'standalone', background_color: '#1a1b1e', theme_color: '#141517',
      icons: [{ src: `${basePath}/icon.png`, sizes: '300x300', type: 'image/png', purpose: 'any maskable' }]
    }),
    { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' } }
  )

  // Static files from pages/public/ — register each as an explicit route so the
  // host server's fetch handler (which only knows its own public dir) can serve them
  const glob = new Bun.Glob('**/*')
  for await (const file of glob.scan({ cwd: CHAT_PUBLIC_DIR, onlyFiles: true })) {
    if (file === '.DS_Store') continue
    const pattern = basePath + '/' + file
    const filePath = CHAT_PUBLIC_DIR + '/' + file
    routes[pattern] = () => new Response(Bun.file(filePath))
  }

  return {
    routes,
    websocket: chat.websocket,
    onServerReady(server) {
      chat.attachServer(server)
      logger.info('server.ready', { basePath })
    },
  }
}

/**
 * Start the devchitchat server as a standalone process.
 *
 * @param {object} config
 * @param {number}  [config.port]       - Port to listen on. Default: process.env.PORT ?? 3000
 * @param {string}  [config.dbPath]     - Path to the SQLite database file. Default: process.env.DB_PATH ?? './data/chat.db'
 * @param {string}  [config.basePath]   - URL subpath to mount the app at, e.g. '/chat'. Default: process.env.BASE_PATH ?? ''
 * @param {boolean} [config.dev]        - Enable dev mode. Default: process.env.NODE_ENV !== 'production'
 * @param {string}  [config.tlsCert]    - Path to TLS certificate. Default: process.env.TLS_CERT ?? './certs/dev-cert.pem'
 * @param {string}  [config.tlsKey]     - Path to TLS private key. Default: process.env.TLS_KEY ?? './certs/dev-key.pem'
 * @returns {Promise<import('bun').Server>}
 */
export async function start(config = {}) {
  const {
    port = Number(process.env.PORT ?? 3000),
    tlsCert = process.env.TLS_CERT ?? './certs/dev-cert.pem',
    tlsKey = process.env.TLS_KEY ?? './certs/dev-key.pem',
  } = config

  const { chat, db, logger, p, basePath, dev } = await _setupServices(config)

  async function getTlsIfAvailable() {
    const cert = Bun.file(tlsCert)
    if (await cert.exists()) return { cert, key: Bun.file(tlsKey) }
    return null
  }

  const server = await createServer({
    pagesDir: CHAT_PAGES_DIR,
    port,
    dev,
    basePath,
    permissionsPolicy: CHAT_PERMISSIONS_POLICY,
    csp: CHAT_CSP,
    idleTimeout: 0,
    routes: {
      [p('/ws')]: (req, server) => {
        const session = sessionFromRequest(req)
        if (server.upgrade(req, {
          data: session ? { userId: session.user.user_id, sessionId: session.session_id, displayName: session.user.display_name } : {}
        })) return
        return new Response('WebSocket upgrade required', { status: 426 })
      },
      [p('/vendor/rdbl.js')]: () =>
        new Response(Bun.file(new URL(import.meta.resolve('@devchitchat/rdbljs/src/rdbl.js'))), {
          headers: { 'Content-Type': 'text/javascript' },
        }),
      [p('/sw.js')]: () => new Response(
        Bun.file(CHAT_PAGES_DIR + '/public/sw.js'),
        { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Service-Worker-Allowed': `${basePath}/`, 'Cache-Control': 'no-cache, no-store' } }
      ),
      [p('/manifest.json')]: () => new Response(
        JSON.stringify({
          name: 'devchitchat', short_name: 'devchitchat',
          start_url: `${basePath}/`, scope: `${basePath}/`,
          display: 'standalone', background_color: '#1a1b1e', theme_color: '#141517',
          icons: [{ src: `${basePath}/icon.png`, sizes: '300x300', type: 'image/png', purpose: 'any maskable' }]
        }),
        { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' } }
      ),
    },
    websocket: chat.websocket,
    tls: await getTlsIfAvailable(),
    onShutdown: (server) => {
      logger.info('server.shutdown', {})
      server.stop()
      db.close()
      process.exit(0)
    },
  })

  chat.attachServer(server)
  logger.info('server.ready', { port: server.port, dev, basePath })
  return server
}

// Run directly when invoked as CLI / bin
if (import.meta.main) {
  await start()
}
