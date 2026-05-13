import { runTransaction } from '../db/transaction.js'

export class SqliteHubRepository {
  constructor({ db }) {
    this.db = db
  }

  insertHubWithOwner({ hubId, name, description, visibility, createdByUserId, now }) {
    runTransaction(this.db, () => {
      this.db.prepare(
        `INSERT INTO hubs (hub_id, name, description, visibility, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(hubId, name, description, visibility, createdByUserId, now)
      this.db.prepare(
        `INSERT INTO hub_members (hub_id, user_id, joined_at) VALUES (?, ?, ?)`
      ).run(hubId, createdByUserId, now)
    })
  }

  listAllHubs() {
    return this.db.prepare(
      `SELECT h.hub_id, h.name, h.description, h.visibility,
         (SELECT COUNT(*) FROM channels c WHERE c.hub_id = h.hub_id AND c.deleted_at IS NULL) AS channel_count
       FROM hubs h WHERE h.deleted_at IS NULL ORDER BY h.sort_order ASC, h.name ASC`
    ).all()
  }

  listAccessibleHubs({ userId }) {
    return this.db.prepare(
      `SELECT h.hub_id, h.name, h.description, h.visibility,
         (SELECT COUNT(*) FROM channels c WHERE c.hub_id = h.hub_id AND c.deleted_at IS NULL) AS channel_count
       FROM hubs h WHERE h.deleted_at IS NULL
       AND (h.visibility = 'public' OR EXISTS (
         SELECT 1 FROM hub_members hm WHERE hm.hub_id = h.hub_id AND hm.user_id = ? AND hm.left_at IS NULL
       ))
       ORDER BY h.sort_order ASC, h.name ASC`
    ).all(userId)
  }

  reorderHubs({ hubIds }) {
    runTransaction(this.db, () => {
      const stmt = this.db.prepare('UPDATE hubs SET sort_order = ? WHERE hub_id = ?')
      hubIds.forEach((id, i) => stmt.run(i, id))
    })
  }

  findById({ hubId }) {
    return this.db.prepare('SELECT * FROM hubs WHERE hub_id = ?').get(hubId) ?? null
  }

  findByName({ name }) {
    return this.db.prepare('SELECT * FROM hubs WHERE name = ? AND deleted_at IS NULL').get(name) ?? null
  }

  findMembership({ hubId, userId }) {
    return this.db.prepare('SELECT * FROM hub_members WHERE hub_id = ? AND user_id = ?').get(hubId, userId) ?? null
  }

  upsertMembership({ hubId, userId, now }) {
    this.db.prepare(
      `INSERT INTO hub_members (hub_id, user_id, joined_at) VALUES (?, ?, ?)
       ON CONFLICT(hub_id, user_id) DO UPDATE SET left_at = NULL`
    ).run(hubId, userId, now)
  }

  setMemberLeft({ hubId, userId, now }) {
    this.db.prepare('UPDATE hub_members SET left_at = ? WHERE hub_id = ? AND user_id = ?').run(now, hubId, userId)
  }

  listMembers({ hubId }) {
    return this.db.prepare(
      `SELECT u.user_id, u.handle, u.display_name, hm.joined_at
       FROM hub_members hm JOIN users u ON hm.user_id = u.user_id
       WHERE hm.hub_id = ? AND hm.left_at IS NULL
       ORDER BY hm.joined_at ASC`
    ).all(hubId)
  }

  patchHub({ hubId, name, description, visibility }) {
    const updates = []
    const params = []
    if (name !== undefined) { updates.push('name = ?'); params.push(name) }
    if (description !== undefined) { updates.push('description = ?'); params.push(description) }
    if (visibility !== undefined) { updates.push('visibility = ?'); params.push(visibility) }
    params.push(hubId)
    this.db.prepare(`UPDATE hubs SET ${updates.join(', ')} WHERE hub_id = ?`).run(...params)
  }

  listActiveChannelIds({ hubId }) {
    return this.db.prepare('SELECT channel_id FROM channels WHERE hub_id = ? AND deleted_at IS NULL').all(hubId).map(r => r.channel_id)
  }

  softDeleteHub({ hubId, now }) {
    runTransaction(this.db, () => {
      this.db.prepare('UPDATE hubs SET deleted_at = ? WHERE hub_id = ?').run(now, hubId)
      this.db.prepare('UPDATE channels SET deleted_at = ? WHERE hub_id = ? AND deleted_at IS NULL').run(now, hubId)
    })
  }
}
