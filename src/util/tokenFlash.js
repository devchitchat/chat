/**
 * Server-side one-time flash store for plaintext bot tokens.
 *
 * The token is stored here after creation and consumed exactly once on the
 * subsequent GET. It is never put in the URL or a cookie. Lost on restart,
 * which is acceptable — the admin can create a new token.
 */
const _flashes = new Map()

export function storeTokenFlash(flashId, token) {
  _flashes.set(flashId, token)
}

export function consumeTokenFlash(flashId) {
  if (!flashId) return null
  const token = _flashes.get(flashId) ?? null
  _flashes.delete(flashId)
  return token
}
