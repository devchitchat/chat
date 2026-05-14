import { newId } from '../util/ids.js'

export class SqlitePushRepository {
  constructor({ db }) {
    this.db = db
  }

  /** Upsert a push subscription for a user. */
  upsertSubscription({ userId, endpoint, p256dh, auth }) {
    const existing = this.db.prepare('SELECT sub_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint)
    const now = Date.now()
    if (existing) {
      this.db.prepare(
        'UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, last_used_at = ? WHERE endpoint = ?'
      ).run(userId, p256dh, auth, now, endpoint)
    } else {
      this.db.prepare(
        'INSERT INTO push_subscriptions (sub_id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(newId('ps'), userId, endpoint, p256dh, auth, now)
    }
  }

  /** Return all subscriptions for a user. */
  getSubscriptionsForUser(userId) {
    return this.db.prepare(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?'
    ).all(userId)
  }

  /** Remove a subscription by endpoint (called when push returns 410/404). */
  removeSubscription(endpoint) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
  }

  /** Remove all subscriptions for a user (e.g. on sign-out). */
  removeAllForUser(userId) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId)
  }
}
