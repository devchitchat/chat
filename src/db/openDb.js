import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const ensureDir = (filePath) => {
  const dir = dirname(filePath)
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export const openDatabase = (filePath) => {
  ensureDir(filePath)
  const db = new Database(filePath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}
