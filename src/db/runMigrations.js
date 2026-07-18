import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATE_DIR = join(__dirname, '../../scripts/migrate')

/**
 * Apply all pending migrations to the given database.
 * Already-applied migrations are skipped. Safe to call on every boot.
 */
export async function runMigrations(db, { logger } = {}) {
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
  const pending = files.filter(f => !applied.has(f))

  if (pending.length === 0) return

  const insertApplied = db.prepare(
    'INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)'
  )

  for (const file of pending) {
    const { run } = await import(join(MIGRATE_DIR, file))
    db.exec('PRAGMA foreign_keys = OFF')
    try {
      db.transaction(() => {
        run(db)
        insertApplied.run(file, Date.now())
      })()
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }
    logger?.info('migration.applied', { file })
  }
}
