/**
 * Add mention tracking and message priority to support the notifications system.
 *
 * deliveries.mention_seq — seq of the last unread @mention for this user in this channel.
 *   0 = no pending mention. Cleared when the user's after_seq advances past it.
 *
 * messages.priority — sender-chosen urgency: 'normal' | 'async' | 'now'.
 *   'normal'  → passive catch-up only (default)
 *   'async'   → subtle sound + queued into reconnect digest
 *   'now'     → push + sound, bypasses DND
 */
export function run(db) {
  try { db.exec(`ALTER TABLE deliveries ADD COLUMN mention_seq INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`) } catch { /* already exists */ }
}
