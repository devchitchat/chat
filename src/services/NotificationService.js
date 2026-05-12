export class NotificationService {
  constructor({ deliveryService, authService }) {
    this.deliveryService = deliveryService
    this.authService = authService
  }

  /**
   * Build the reconnect digest for a user.
   * Returns { channels, dms } — only entries with unread > 0 or a pending mention.
   *
   * @param {string} userId
   * @param {number} [lastSeenAt] — epoch ms of last session activity; used for away_duration_ms
   */
  buildDigest(userId, lastSeenAt = null) {
    const rows = this.deliveryService.buildDigestData({ userId })
    const channels = []
    const dms = []

    for (const row of rows) {
      const unread = Math.max(0, (row.max_seq ?? 0) - (row.after_seq ?? 0))
      const hasMention = (row.mention_seq ?? 0) > (row.after_seq ?? 0)
      if (unread === 0 && !hasMention) continue

      if (row.kind === 'dm') {
        const other = row.other_user_id ? this.authService.getUser(row.other_user_id) : null
        dms.push({
          channel_id: row.channel_id,
          with_user: { user_id: row.other_user_id, display_name: other?.display_name ?? row.other_user_id },
          unread,
        })
      } else {
        channels.push({
          channel_id: row.channel_id,
          name: row.name,
          unread,
          mentions: hasMention ? 1 : 0,
        })
      }
    }

    const away_duration_ms = lastSeenAt ? Math.max(0, Date.now() - lastSeenAt) : null
    return { channels, dms, away_duration_ms }
  }
}
