#!/usr/bin/env bun
/**
 * Purge the Cloudflare cache for a domain (purge everything).
 *
 * Usage:
 *   bun scripts/purge-cf-cache.js <domain>
 *   bun purge-cf-cache chat.example.com
 *
 * Env (required):
 *   CF_API_TOKEN — Cloudflare API token with Zone.Cache Purge permission
 *
 * The zone ID is resolved automatically from the domain name.
 */

const domain = 'devchitchat.com'
const token = process.env.CF_API_TOKEN
if (!token) {
  console.error('CF_API_TOKEN is not set')
  process.exit(1)
}

const headers = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
}

// 1. Resolve zone ID from domain
process.stdout.write(`Looking up zone for ${domain} ... `)
const zonesRes = await fetch(
  `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain)}&status=active`,
  { headers }
)
const zonesData = await zonesRes.json()

if (!zonesData.success || zonesData.result.length === 0) {
  console.log('FAILED')
  console.error(zonesData.errors?.map(e => e.message).join(', ') ?? 'Zone not found')
  process.exit(1)
}

const zone = zonesData.result[0]
console.log(`ok (${zone.id})`)

// 2. Purge everything
process.stdout.write(`Purging cache ... `)
const purgeRes = await fetch(
  `https://api.cloudflare.com/client/v4/zones/${zone.id}/purge_cache`,
  { method: 'POST', headers, body: JSON.stringify({ purge_everything: true }) }
)
const purgeData = await purgeRes.json()

if (!purgeData.success) {
  console.log('FAILED')
  console.error(purgeData.errors?.map(e => e.message).join(', '))
  process.exit(1)
}

console.log('ok')
console.log(`\nCache purged for ${domain}.`)
