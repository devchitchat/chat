export function handleUsageReport(ws, msg, ctx) {
  const { auth, tokenUsageService, sendWs } = ctx
  if (!tokenUsageService) return

  // Only bots may submit usage reports
  const user = auth.getUser(ws.data.userId)
  if (!user?.roles?.includes('bot')) {
    return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'FORBIDDEN', message: 'Only bots may report usage' } })
  }

  const {
    channel_id, channel_name, channel_kind,
    actor_id, actor_display_name,
    repo, session_id,
    input_tokens, output_tokens,
    cache_read_tokens, cache_creation_tokens,
    cost_usd,
  } = msg.body || {}

  tokenUsageService.record({
    actorId:             actor_id,
    actorDisplayName:    actor_display_name ?? null,
    channelId:           channel_id,
    channelName:         channel_name ?? null,
    channelKind:         channel_kind ?? null,
    sessionId:           session_id ?? null,
    repo:                repo ?? null,
    inputTokens:         input_tokens ?? 0,
    outputTokens:        output_tokens ?? 0,
    cacheReadTokens:     cache_read_tokens ?? 0,
    cacheCreationTokens: cache_creation_tokens ?? 0,
    costUsd:             cost_usd ?? null,
  })
}
