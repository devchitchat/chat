/**
 * Backfill fts_messages from the messages table.
 *
 * The FTS index is only populated at message send/edit time.
 * Any messages that existed before search was wired in are missing from
 * the index.  This migration does a full rebuild so they become searchable.
 *
 * Safe to run on FTS5 virtual tables and on the plain-table fallback alike:
 * clearing and re-inserting is idempotent.
 */
export function run(db) {
  db.exec(`DELETE FROM fts_messages`)
  db.exec(`
    INSERT INTO fts_messages (text, channel_id, msg_id, seq, user_id, ts)
    SELECT text, channel_id, msg_id, seq, user_id, ts
    FROM messages
    WHERE deleted_at IS NULL
      AND text IS NOT NULL
      AND text != ''
  `)
}
