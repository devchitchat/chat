import { runTransaction } from '../db/transaction.js'

export class SqliteChannelRepository {
  constructor({ db }) {
    this.db = db
  }

  insertChannelWithOwner({ channelId, kind, name, topic, visibility, sessionEndsAt = null, createdByUserId, now }) {
    runTransaction(this.db, () => {
      const nextOrder = (this.db.prepare(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM channels WHERE deleted_at IS NULL`
      ).get()?.next ?? 0)
      this.db.prepare(
        `INSERT INTO channels (channel_id, kind, name, topic, visibility, sort_order, session_ends_at, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(channelId, kind, name, topic, visibility, nextOrder, sessionEndsAt, createdByUserId, now)
      this.db.prepare(
        `INSERT INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`
      ).run(channelId, createdByUserId, now)
    })
  }

  listAll() {
    return this.db.prepare(
      `SELECT c.channel_id, c.name, c.kind, c.visibility, c.topic, c.sort_order, c.session_ends_at
       FROM channels c
       WHERE c.deleted_at IS NULL AND c.kind != 'dm'
       ORDER BY c.kind, c.sort_order ASC, c.created_at ASC`
    ).all()
  }

  listPublicNonDm() {
    return this.db.prepare(
      `SELECT channel_id, name, kind, visibility, topic, sort_order, session_ends_at
       FROM channels WHERE deleted_at IS NULL AND kind != 'dm' AND visibility = 'public'`
    ).all()
  }

  listMemberships({ userId }) {
    return this.db.prepare(
      `SELECT c.channel_id, c.name, c.kind, c.visibility, c.topic, c.sort_order
       FROM channels c
       JOIN channel_members cm ON cm.channel_id = c.channel_id
       WHERE c.deleted_at IS NULL
         AND cm.user_id = ? AND cm.left_at IS NULL AND cm.banned_at IS NULL
       ORDER BY c.sort_order ASC, c.created_at ASC`
    ).all(userId)
  }

  listAccessible({ userId, isGuest = false }) {
    return this.db.prepare(
      `SELECT c.channel_id, c.name, c.kind, c.visibility, c.topic, c.sort_order, c.session_ends_at
       FROM channels c
       WHERE c.deleted_at IS NULL
         AND c.kind != 'dm'
         AND (
           EXISTS (
             SELECT 1 FROM channel_members cm
             WHERE cm.channel_id = c.channel_id AND cm.user_id = ?
               AND cm.left_at IS NULL AND cm.banned_at IS NULL
           )
           OR (? = 0 AND c.visibility = 'public')
         )
       ORDER BY c.kind, c.sort_order ASC, c.created_at ASC`
    ).all(userId, isGuest ? 1 : 0)
  }

  findById({ channelId }) {
    return this.db.prepare('SELECT * FROM channels WHERE channel_id = ?').get(channelId) ?? null
  }

  findMembership({ channelId, userId }) {
    return this.db.prepare('SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId) ?? null
  }

  findByName({ name }) {
    return this.db.prepare('SELECT * FROM channels WHERE name = ? AND deleted_at IS NULL').get(name) ?? null
  }

  findDmByName({ name }) {
    return this.db.prepare(`SELECT * FROM channels WHERE kind = 'dm' AND name = ? AND deleted_at IS NULL`).get(name) ?? null
  }

  insertDmChannel({ channelId, name, userIdA, userIdB, now }) {
    runTransaction(this.db, () => {
      this.db.prepare(
        `INSERT INTO channels (channel_id, kind, name, topic, visibility, sort_order, created_by_user_id, created_at)
         VALUES (?, 'dm', ?, NULL, 'private', 0, ?, ?)`
      ).run(channelId, name, userIdA, now)
      this.db.prepare(
        `INSERT INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`
      ).run(channelId, userIdA, now)
      this.db.prepare(
        `INSERT INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`
      ).run(channelId, userIdB, now)
    })
  }

  listDmsByUser({ userId }) {
    return this.db.prepare(
      `SELECT c.channel_id, c.name, c.kind,
              other.user_id AS other_user_id
       FROM channels c
       JOIN channel_members cm  ON cm.channel_id = c.channel_id AND cm.user_id = ? AND cm.left_at IS NULL
       LEFT JOIN channel_members other ON other.channel_id = c.channel_id AND other.user_id != ? AND other.left_at IS NULL
       WHERE c.kind = 'dm' AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC`
    ).all(userId, userId)
  }

  upsertMembership({ channelId, userId, role, now }) {
    this.db.prepare(
      `INSERT INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id, user_id) DO UPDATE SET left_at = NULL, banned_at = NULL`
    ).run(channelId, userId, role, now)
  }

  setMemberLeft({ channelId, userId, now }) {
    this.db.prepare('UPDATE channel_members SET left_at = ? WHERE channel_id = ? AND user_id = ?').run(now, channelId, userId)
  }

  listActiveMembers({ channelId }) {
    return this.db.prepare(
      `SELECT user_id, role FROM channel_members WHERE channel_id = ? AND left_at IS NULL AND banned_at IS NULL`
    ).all(channelId)
  }

  patchChannel({ channelId, name, topic, visibility, session_ends_at }) {
    const updates = []
    const params = []
    if (name !== undefined) { updates.push('name = ?'); params.push(name) }
    if (topic !== undefined) { updates.push('topic = ?'); params.push(topic) }
    if (visibility !== undefined) { updates.push('visibility = ?'); params.push(visibility) }
    if (session_ends_at !== undefined) { updates.push('session_ends_at = ?'); params.push(session_ends_at) }
    if (!updates.length) return
    params.push(channelId)
    this.db.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE channel_id = ?`).run(...params)
  }

  softDeleteChannel({ channelId, now }) {
    this.db.prepare('UPDATE channels SET deleted_at = ? WHERE channel_id = ?').run(now, channelId)
  }

  reorderChannels({ channelIds }) {
    runTransaction(this.db, () => {
      const stmt = this.db.prepare(
        `UPDATE channels SET sort_order = ? WHERE channel_id = ? AND deleted_at IS NULL`
      )
      channelIds.forEach((channelId, index) => stmt.run(index, channelId))
    })
    return channelIds
      .map(id => this.db.prepare('SELECT channel_id, name, kind, visibility, topic, sort_order, session_ends_at FROM channels WHERE channel_id = ?').get(id))
      .filter(Boolean)
  }

  searchFtsGlobal({ channelIds, query, limit = 20 }) {
    if (!channelIds.length) return []
    const placeholders = channelIds.map(() => '?').join(', ')
    return this.db.prepare(
      `SELECT m.msg_id, m.channel_id, m.seq, m.user_id, m.ts,
              snippet(fts_messages, 0, '<mark>', '</mark>', '…', 24) AS snippet
       FROM fts_messages fts
       JOIN messages m ON fts.msg_id = m.msg_id
       WHERE fts_messages MATCH ? AND m.channel_id IN (${placeholders})
         AND m.deleted_at IS NULL
       ORDER BY fts.rank
       LIMIT ?`
    ).all(query, ...channelIds, limit)
  }

  searchLikeGlobal({ channelIds, query, limit = 20 }) {
    if (!channelIds.length) return []
    const placeholders = channelIds.map(() => '?').join(', ')
    return this.db.prepare(
      `SELECT msg_id, channel_id, seq, user_id, ts, text AS snippet
       FROM messages
       WHERE channel_id IN (${placeholders}) AND text LIKE ? AND deleted_at IS NULL
       ORDER BY ts DESC
       LIMIT ?`
    ).all(...channelIds, `%${query}%`, limit)
  }
}
