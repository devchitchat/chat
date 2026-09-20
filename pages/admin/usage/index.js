import { requireAdminSession } from '../../../src/adminAuth.js'
import { tokenUsageService } from '../../../src/context.js'
import { BASE_PATH } from '../../../src/config.js'

const DAY_MS  = 24 * 60 * 60 * 1000
const PERIODS = {
  '7d':  7  * DAY_MS,
  '30d': 30 * DAY_MS,
  'all': 0,
}

function fmtTokens(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function fmtCost(n) {
  if (!n) return '—'
  return '$' + Number(n).toFixed(4)
}

export function GET(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session

  const url    = new URL(req.url)
  const period = PERIODS[url.searchParams.get('period')] !== undefined
    ? url.searchParams.get('period')
    : '30d'
  const sinceTs = PERIODS[period] ? Date.now() - PERIODS[period] : 0

  const data = tokenUsageService.getDashboard({ sinceTs })

  return {
    base:      BASE_PATH,
    user:      session.user,
    pageTitle: 'Admin — Token Usage',
    period,
    summary: {
      turns:        data.summary.turns ?? 0,
      inputTokens:  fmtTokens(data.summary.input_tokens),
      outputTokens: fmtTokens(data.summary.output_tokens),
      cacheTokens:  fmtTokens(data.summary.cache_tokens),
      totalTokens:  fmtTokens(data.summary.total_tokens),
      costUsd:      fmtCost(data.summary.cost_usd),
    },
    byActor: data.byActor.map(r => ({
      name:         r.actor_display_name ?? r.actor_id,
      turns:        r.turns,
      inputTokens:  fmtTokens(r.input_tokens),
      outputTokens: fmtTokens(r.output_tokens),
      totalTokens:  fmtTokens(r.total_tokens),
      costUsd:      fmtCost(r.cost_usd),
    })),
    byChannel: data.byChannel.map(r => ({
      name:        r.channel_name ?? r.channel_id,
      kind:        r.channel_kind ?? '',
      turns:       r.turns,
      totalTokens: fmtTokens(r.total_tokens),
      costUsd:     fmtCost(r.cost_usd),
    })),
    byRepo: data.byRepo.map(r => ({
      repo:        r.repo,
      turns:       r.turns,
      totalTokens: fmtTokens(r.total_tokens),
      costUsd:     fmtCost(r.cost_usd),
    })),
    recent: data.recent.map(r => ({
      ts:          new Date(r.ts).toLocaleString(),
      actor:       r.actor_display_name ?? '—',
      channel:     r.channel_name ?? '—',
      kind:        r.channel_kind ?? '',
      repo:        r.repo ?? '—',
      totalTokens: fmtTokens((r.input_tokens ?? 0) + (r.output_tokens ?? 0)),
      costUsd:     fmtCost(r.cost_usd),
    })),
  }
}
