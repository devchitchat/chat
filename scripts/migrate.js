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

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH ?? 'data/chat.db'
const MIGRATE_DIR = join(__dirname, 'migrate')

const args = new Set(process.argv.slice(2))
const isDry = args.has('--dry')
const isStatus = args.has('--status')

// ── Open database ────────────────────────────────────────────────────────────

const db = openDatabase(DB_PATH)

// Ensure base schema exists before running migrations so that ALTER TABLE /
// CREATE INDEX statements in migration files always have a table to work with.
// createSchema is pure DDL — no writes, fully idempotent.
createSchema(db)

// ── Ensure _migrations table ─────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS _migrations (
    filename   TEXT    PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )
`)

// ── Discover migration files ─────────────────────────────────────────────────

const files = readdirSync(MIGRATE_DIR)
  .filter(f => f.endsWith('.js'))
  .sort()

if (files.length === 0) {
  console.log('No migration files found in', MIGRATE_DIR)
  process.exit(0)
}

// ── Load applied set ─────────────────────────────────────────────────────────

const applied = new Set(
  db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
)

// ── Status mode ──────────────────────────────────────────────────────────────

if (isStatus) {
  console.log('\nMigration status:\n')
  for (const file of files) {
    const state = applied.has(file) ? '✓ applied' : '○ pending'
    console.log(` ${state}  ${file}`)
  }
  console.log()
  process.exit(0)
}

// ── Determine pending ────────────────────────────────────────────────────────

const pending = files.filter(f => !applied.has(f))

if (pending.length === 0) {
  console.log('Nothing to migrate — all migrations already applied.')
  process.exit(0)
}

if (isDry) {
  console.log('\nPending migrations (--dry, not applied):\n')
  for (const file of pending) console.log(' ', file)
  console.log()
  process.exit(0)
}

// ── Apply pending migrations ─────────────────────────────────────────────────

const insertApplied = db.prepare(
  'INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)'
)

let applied_count = 0

for (const file of pending) {
  const filePath = join(MIGRATE_DIR, file)
  process.stdout.write(`  applying ${file} ... `)
  try {
    const { run } = await import(filePath)
    // Disable FK enforcement before the transaction — PRAGMA foreign_keys is a
    // no-op inside a transaction, so it must be set at the connection level first.
    db.exec('PRAGMA foreign_keys = OFF')
    try {
      db.transaction(() => {
        run(db)
        insertApplied.run(file, Date.now())
      })()
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }
    console.log('ok')
    applied_count++
  } catch (err) {
    console.log('FAILED')
    console.error(`\nMigration failed: ${file}`)
    console.error(err.message)
    console.error('\nStopping. Fix the migration and re-run.')
    process.exit(1)
  }
}

console.log(`\n${applied_count} migration(s) applied.`)
