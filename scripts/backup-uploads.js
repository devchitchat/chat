#!/usr/bin/env bun
/**
 * Mirror the uploads directory to a backup location.
 * Overwrites the destination with the current state of uploads — not versioned.
 * Safe to run against a live server.
 *
 * Usage: bun scripts/backup-uploads.js
 * Env:   UPLOAD_DIR         — source uploads directory (default: data/uploads)
 *        UPLOADS_BACKUP_DIR — backup destination      (default: data/backups/uploads)
 */

import { cpSync, mkdirSync } from 'node:fs'

const uploadDir      = process.env.UPLOAD_DIR         ?? 'data/uploads'
const uploadsBackDir = process.env.UPLOADS_BACKUP_DIR ?? 'data/backups/uploads'

mkdirSync(uploadsBackDir, { recursive: true })
cpSync(uploadDir, uploadsBackDir, { recursive: true, force: true })

console.log(`Mirrored ${uploadDir} → ${uploadsBackDir}`)
