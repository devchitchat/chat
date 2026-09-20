export class SqliteTokenUsageRepository {
  constructor({ db }) {
    this.db = db
  }

  insert({ ts, actorId, actorDisplayName, channelId, channelName, channelKind, sessionId, repo, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd }) {
    this.db.prepare(`
      INSERT INTO token_usage
        (ts, actor_id, actor_display_name, channel_id, channel_name, channel_kind, session_id, repo,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ts, actorId, actorDisplayName ?? null, channelId, channelName ?? null, channelKind ?? null,
           sessionId ?? null, repo ?? null, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd ?? null)
  }

  /** Total tokens and cost across all records, optionally filtered by ts >= sinceTs */
  summary({ sinceTs = 0 } = {}) {
    return this.db.prepare(`
      SELECT
        COUNT(*)              AS turns,
        SUM(input_tokens)     AS input_tokens,
        SUM(output_tokens)    AS output_tokens,
        SUM(cache_read_tokens + cache_creation_tokens) AS cache_tokens,
        SUM(input_tokens + output_tokens) AS total_tokens,
        SUM(cost_usd)         AS cost_usd
      FROM token_usage WHERE ts >= ?
    `).get(sinceTs)
  }

  byActor({ sinceTs = 0 } = {}) {
    return this.db.prepare(`
      SELECT
        actor_id, actor_display_name,
        COUNT(*)              AS turns,
        SUM(input_tokens)     AS input_tokens,
        SUM(output_tokens)    AS output_tokens,
        SUM(input_tokens + output_tokens) AS total_tokens,
        SUM(cost_usd)         AS cost_usd
      FROM token_usage WHERE ts >= ?
      GROUP BY actor_id
      ORDER BY total_tokens DESC
    `).all(sinceTs)
  }

  byChannel({ sinceTs = 0 } = {}) {
    return this.db.prepare(`
      SELECT
        channel_id, channel_name, channel_kind,
        COUNT(*)              AS turns,
        SUM(input_tokens + output_tokens) AS total_tokens,
        SUM(cost_usd)         AS cost_usd
      FROM token_usage WHERE ts >= ?
      GROUP BY channel_id
      ORDER BY total_tokens DESC
    `).all(sinceTs)
  }

  byRepo({ sinceTs = 0 } = {}) {
    return this.db.prepare(`
      SELECT
        COALESCE(repo, '(none)') AS repo,
        COUNT(*)              AS turns,
        SUM(input_tokens + output_tokens) AS total_tokens,
        SUM(cost_usd)         AS cost_usd
      FROM token_usage WHERE ts >= ?
      GROUP BY repo
      ORDER BY total_tokens DESC
    `).all(sinceTs)
  }

  recent({ sinceTs = 0, limit = 50 } = {}) {
    return this.db.prepare(`
      SELECT id, ts, actor_display_name, channel_name, channel_kind, repo,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
      FROM token_usage WHERE ts >= ?
      ORDER BY ts DESC LIMIT ?
    `).all(sinceTs, limit)
  }
}
