#!/usr/bin/env bun
/**
 * Migration runner.
 *
 * Usage:
 *   bun run migrate          — apply all pending migrations
 *   bun run migrate --dry    — print pending migrations without applying them
 *   bun run migrate --status — list all migrations and their applied status
 *
 * Migration files live in scripts/migrate/ and must:
 *   - Be named NNN-description.js (e.g. 001-drop-channel-invites.js)
 *   - Export a run(db) function
 *
 * Applied migrations are tracked in the _migrations table in the database.
 * Files are applied in filename order; already-applied files are skipped.
 */

import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db/openDb.js'
import { createSchema } from '../src/db/initDb.js'
import { runMigrations } from '../src/db/runMigrations.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH ?? 'data/chat.db'
const MIGRATE_DIR = join(__dirname, 'migrate')

const args = new Set(process.argv.slice(2))
const isDry = args.has('--dry')
const isStatus = args.has('--status')

const db = openDatabase(DB_PATH)
createSchema(db)

// ── Status / dry-run modes ───────────────────────────────────────────────────

if (isStatus || isDry) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT    PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
  const files = readdirSync(MIGRATE_DIR).filter(f => f.endsWith('.js')).sort()
  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
  )

  if (isStatus) {
    console.log('\nMigration status:\n')
    for (const file of files) {
      console.log(` ${applied.has(file) ? '✓ applied' : '○ pending'}  ${file}`)
    }
    console.log()
  } else {
    const pending = files.filter(f => !applied.has(f))
    console.log('\nPending migrations (--dry, not applied):\n')
    for (const file of pending) console.log(' ', file)
    console.log()
  }
  process.exit(0)
}

// ── Apply ────────────────────────────────────────────────────────────────────

const before = db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
await runMigrations(db, {
  logger: { info: (_, { file }) => console.log(`  applying ${file} ... ok`) }
})
const after = db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
const count = after.length - before.length

if (count === 0) {
  console.log('Nothing to migrate — all migrations already applied.')
} else {
  console.log(`\n${count} migration(s) applied.`)
}
