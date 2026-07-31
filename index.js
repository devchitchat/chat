#!/usr/bin/env bun
import { createServer } from '@devchitchat/index97'
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

/**
 * Start the devchitchat server.
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
    dbPath = process.env.DB_PATH ?? './data/chat.db',
    basePath = (process.env.BASE_PATH ?? '').replace(/\/$/, ''),
    dev = process.env.NODE_ENV !== 'production',
    tlsCert = process.env.TLS_CERT ?? './certs/dev-cert.pem',
    tlsKey = process.env.TLS_KEY ?? './certs/dev-key.pem',
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

  // Wire service context so page handlers (pages/**/*.js) can access services
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

  async function getTlsIfAvailable() {
    const cert = Bun.file(tlsCert)
    if (await cert.exists()) {
      return { cert, key: Bun.file(tlsKey) }
    }
    return null
  }

  const server = await createServer({
    pagesDir: import.meta.dir + '/pages',
    port,
    dev,
    basePath,
    // Allow camera/mic/display for WebRTC
    permissionsPolicy: 'camera=(self), microphone=(self), display-capture=(self)',
    // CSP: allow WebSocket connections to self
    csp: "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:",
    // So the SSE doesn't timeout.
    idleTimeout: 0,
    // WebSocket upgrade route — authenticate via session cookie before the first message
    routes: {
      [p('/ws')]: (req, server) => {
        const session = sessionFromRequest(req)
        if (server.upgrade(req, {
          data: session ? { userId: session.user.user_id, sessionId: session.session_id, displayName: session.user.display_name } : {}
        })) return
        return new Response('WebSocket upgrade required', { status: 426 })
      },
      [p('/vendor/rdbl.js')]: () => {
        return new Response(Bun.file(new URL(import.meta.resolve('@devchitchat/rdbljs/src/rdbl.js'))), {
          headers: { 'Content-Type': 'text/javascript' },
        })
      },
      // Service worker at basePath scope so it can receive push events for all app pages
      [p('/sw.js')]: () => new Response(
        Bun.file(import.meta.dir + '/pages/public/sw.js'),
        { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Service-Worker-Allowed': `${basePath}/`, 'Cache-Control': 'no-cache, no-store' } }
      ),
      // Dynamic PWA manifest — start_url and icon.src must reflect basePath
      [p('/manifest.json')]: () => new Response(
        JSON.stringify({
          name: 'devchitchat',
          short_name: 'devchitchat',
          start_url: `${basePath}/`,
          scope: `${basePath}/`,
          display: 'standalone',
          background_color: '#1a1b1e',
          theme_color: '#141517',
          icons: [
            { src: `${basePath}/icon.png`, sizes: '300x300', type: 'image/png', purpose: 'any maskable' }
          ]
        }),
        { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' } }
      ),
    },

    // Bun native WebSocket handler (new index97 passthrough)
    websocket: chat.websocket,
    tls: await getTlsIfAvailable(),
    onShutdown: (server) => {
      logger.info('server.shutdown', {})
      server.stop()
      db.close()
      process.exit(0)
    },
  })

  // Give ChatServer a reference to the Bun server so it can publish to topics
  chat.attachServer(server)

  logger.info('server.ready', { port: server.port, dev, basePath })

  return server
}

// Run directly when invoked as CLI / bin
if (import.meta.main) {
  await start()
}
