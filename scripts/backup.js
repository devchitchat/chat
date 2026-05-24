/**
 * Backup the SQLite database using SQLite's official VACUUM INTO facility.
 * Safe to run against a live, WAL-mode database.
 *
 * Usage: bun scripts/backup.js
 * Env:   DB_PATH  — path to source database (default: data/chat.db)
 *        BACKUP_DIR — directory for backup files (default: data/backups)
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'

const dbPath = process.env.DB_PATH ?? 'data/chat.db'
const backupDir = process.env.BACKUP_DIR ?? join(dirname(dbPath), 'backups')

const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
const backupPath = join(backupDir, `chat-${ts}.db`)

mkdirSync(backupDir, { recursive: true })

const db = new Database(dbPath, { readonly: true })
db.exec(`VACUUM INTO '${backupPath}'`)
db.close()

console.log(`Backed up ${dbPath} → ${backupPath}`)
