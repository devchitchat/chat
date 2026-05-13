/**
 * Service context singleton.
 *
 * index97 imports page handlers dynamically. ES modules are singletons,
 * so any handler that imports from this file gets the same live references
 * that were wired up in index.js at startup.
 *
 * Usage in a page handler:
 *   import { auth, channelService, messageService } from '../../src/context.js'
 */

export let auth = null
export let hubService = null
export let channelService = null
export let messageService = null
export let deliveryService = null
export let searchService = null
export let presenceService = null
export let signalingService = null
export let userSettingsService = null
export let botService = null
export let uploadService = null
export let logger = null

export function init(services) {
  auth = services.auth
  hubService = services.hubService
  channelService = services.channelService
  messageService = services.messageService
  deliveryService = services.deliveryService
  searchService = services.searchService
  presenceService = services.presenceService
  signalingService = services.signalingService
  userSettingsService = services.userSettingsService
  botService = services.botService
  uploadService = services.uploadService
  logger = services.logger
}

/**
 * Parse session token from a request's cookie header.
 * Returns { session, user } or null if unauthenticated.
 */
export function sessionFromRequest(req) {
  const cookie = req.headers.get('cookie') || ''
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/)
  if (!match) return null
  return auth.validateSession(decodeURIComponent(match[1]))
}

/**
 * Build a Set-Cookie header string for a session token.
 */
export function sessionCookie(token, { maxAgeSec = 30 * 24 * 60 * 60, clear = false } = {}) {
  if (clear) return 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
  return `session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
}
