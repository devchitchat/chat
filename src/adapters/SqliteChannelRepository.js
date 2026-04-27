import { runTransaction } from '../db/transaction.js'

export class SqliteChannelRepository {
  constructor({ db }) {
    this.db = db
  }

  insertChannelWithOwner({ channelId, hubId, kind, name, topic, visibility, createdByUserId, now }) {
    runTransaction(this.db, () => {
      const nextOrder = (this.db.prepare(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM channels WHERE hub_id = ? AND deleted_at IS NULL`
      ).get(hubId)?.next ?? 0)
      this.db.prepare(
        `INSERT INTO channels (channel_id, hub_id, kind, name, topic, visibility, sort_order, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(channelId, hubId, kind, name, topic, visibility, nextOrder, createdByUserId, now)
      this.db.prepare(
        `INSERT INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`
      ).run(channelId, createdByUserId, now)
    })
  }

  listInHub({ hubId }) {
    return this.db.prepare(
      `SELECT c.channel_id, c.hub_id, c.name, c.kind, c.visibility, c.topic, c.sort_order
       FROM channels c WHERE c.hub_id = ? AND c.deleted_at IS NULL
       ORDER BY c.sort_order ASC, c.created_at ASC`
    ).all(hubId)
  }

  listAccessibleInHub({ hubId, userId }) {
    return this.db.prepare(
      `SELECT c.channel_id, c.hub_id, c.name, c.kind, c.visibility, c.topic, c.sort_order
       FROM channels c WHERE c.hub_id = ? AND c.deleted_at IS NULL
       AND (c.visibility = 'public' OR EXISTS (
         SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.channel_id
         AND cm.user_id = ? AND cm.left_at IS NULL AND cm.banned_at IS NULL
       ))
       ORDER BY c.sort_order ASC, c.created_at ASC`
    ).all(hubId, userId)
  }

  listAll() {
    return this.db.prepare(
      `SELECT c.channel_id, c.hub_id, c.name, c.kind, c.visibility, c.topic, c.sort_order, h.name AS hub_name
       FROM channels c JOIN hubs h ON c.hub_id = h.hub_id
       WHERE c.deleted_at IS NULL AND h.deleted_at IS NULL
       ORDER BY h.name, c.sort_order ASC, c.created_at ASC`
    ).all()
  }

  listAccessible({ userId }) {
    return this.db.prepare(
      `SELECT c.channel_id, c.hub_id, c.name, c.kind, c.visibility, c.topic, c.sort_order, h.name AS hub_name
       FROM channels c JOIN hubs h ON c.hub_id = h.hub_id
       WHERE c.deleted_at IS NULL AND h.deleted_at IS NULL
       AND ((h.visibility = 'public' AND c.visibility = 'public')
         OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.channel_id AND cm.user_id = ? AND cm.left_at IS NULL AND cm.banned_at IS NULL)
         OR EXISTS (SELECT 1 FROM hub_members hm WHERE hm.hub_id = h.hub_id AND hm.user_id = ? AND hm.left_at IS NULL))
       ORDER BY h.name, c.sort_order ASC, c.created_at ASC`
    ).all(userId, userId)
  }

  findById({ channelId }) {
    return this.db.prepare('SELECT * FROM channels WHERE channel_id = ?').get(channelId) ?? null
  }

  findMembership({ channelId, userId }) {
    return this.db.prepare('SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId) ?? null
  }

  findByHubAndName({ hubId, name }) {
    return this.db.prepare('SELECT * FROM channels WHERE hub_id = ? AND name = ? AND deleted_at IS NULL').get(hubId, name) ?? null
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

  insertInvite({ inviteId, channelId, tokenHash, createdByUserId, now, expiresAt, maxUses }) {
    this.db.prepare(
      `INSERT INTO channel_invites (invite_id, channel_id, token_hash, created_by_user_id, created_at, expires_at, max_uses, uses)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(inviteId, channelId, tokenHash, createdByUserId, now, expiresAt, maxUses)
  }

  findInviteByTokenHash({ tokenHash }) {
    return this.db.prepare('SELECT * FROM channel_invites WHERE token_hash = ?').get(tokenHash) ?? null
  }

  redeemInvite({ inviteId, channelId, userId, now }) {
    runTransaction(this.db, () => {
      this.db.prepare('UPDATE channel_invites SET uses = uses + 1 WHERE invite_id = ?').run(inviteId)
      this.db.prepare(
        `INSERT INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)
         ON CONFLICT(channel_id, user_id) DO UPDATE SET left_at = NULL, banned_at = NULL`
      ).run(channelId, userId, now)
    })
  }

  patchChannel({ channelId, name, topic }) {
    const updates = []
    const params = []
    if (name !== undefined) { updates.push('name = ?'); params.push(name) }
    if (topic !== undefined) { updates.push('topic = ?'); params.push(topic) }
    params.push(channelId)
    this.db.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE channel_id = ?`).run(...params)
  }

  softDeleteChannel({ channelId, now }) {
    this.db.prepare('UPDATE channels SET deleted_at = ? WHERE channel_id = ?').run(now, channelId)
  }

  reorderChannels({ hubId, channelIds }) {
    runTransaction(this.db, () => {
      const stmt = this.db.prepare(
        `UPDATE channels SET sort_order = ? WHERE channel_id = ? AND hub_id = ? AND deleted_at IS NULL`
      )
      channelIds.forEach((channelId, index) => stmt.run(index, channelId, hubId))
    })
    return this.listInHub({ hubId })
  }
}
