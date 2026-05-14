import { createServer } from '@devchitchat/index97'
import { openDatabase } from './src/db/openDb.js'
import { initDb } from './src/db/initDb.js'
import { createLogger } from './src/util/logger.js'
import { ChatServer } from './src/ws/ChatServer.js'
import { init as initContext, sessionFromRequest } from './src/context.js'
import { UserSettingsService } from './src/services/UserSettingsService.js'
import { SqliteUserSettingsRepository } from './src/adapters/SqliteUserSettingsRepository.js'
import { UploadService } from './src/services/UploadService.js'
import { LocalFileStore } from './src/adapters/LocalFileStore.js'
import { SqliteUploadRepository } from './src/adapters/SqliteUploadRepository.js'

const logger = createLogger()
const db = openDatabase(process.env.DB_PATH ?? './data/chat.db')
initDb(db)

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
  logger,
})

const port = Number(process.env.PORT ?? 3000)
const dev = process.env.NODE_ENV !== 'production'
async function getCertsIfAvailable() {
  let cert = Bun.file('./certs/dev-cert.pem')
  if (await cert.exists()){
    return {
      cert: cert,
      key: Bun.file('./certs/dev-key.pem')
    }
  }
  return null
}
const server = await createServer({
  pagesDir: import.meta.dir + '/pages',
  port,
  dev,
  // Allow camera/mic/display for WebRTC
  permissionsPolicy: 'camera=(self), microphone=(self), display-capture=(self)',
  // CSP: allow WebSocket connections to self
  csp: "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:",

  // WebSocket upgrade route — client connects to /ws
  // Authenticate via the session cookie at upgrade time so ws.data.userId is
  // set before the first message arrives. The session cookie is HttpOnly, so
  // client JS cannot read it; the upgrade request is the only place to check it.
  routes: {
    '/ws': (req, server) => {
      const session = sessionFromRequest(req)
      if (server.upgrade(req, {
        data: session ? { userId: session.user.user_id, sessionId: session.session_id, displayName: session.user.display_name } : {}
      })) return
      return new Response('WebSocket upgrade required', { status: 426 })
    },
    '/vendor/rdbl.js': () => {
      return new Response(Bun.file(import.meta.dir + '/node_modules/@devchitchat/rdbljs/src/rdbl.js'), {
        headers: { 'Content-Type': 'text/javascript' },
      })
    },
    // Service worker at root scope so it can receive push events for all pages
    '/sw.js': () => new Response(
      Bun.file(import.meta.dir + '/pages/public/sw.js'),
      { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache, no-store' } }
    ),
  },

  // Bun native WebSocket handler (new index97 passthrough)
  websocket: chat.websocket,
  tls: await getCertsIfAvailable(),
  onShutdown: (server) => {
    logger.info('server.shutdown', {})
    server.stop()
    db.close()
  },
})

// Give ChatServer a reference to the Bun server so it can publish to topics
chat.attachServer(server)

logger.info('server.ready', { port: server.port, dev })
