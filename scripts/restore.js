#!/usr/bin/env bun
/**
 * Restore a SQLite backup to the Kubernetes cluster.
 *
 * Copies a local backup file into the chat-web-sqlite PVC via a temporary
 * helper pod, then replaces the live database. The deployment is scaled to
 * zero before the restore and back to one afterwards.
 *
 * Usage:
 *   bun scripts/restore.js <path-to-backup.db>
 *   bun restore ../backups/chat-2026-05-27_03-00-00.db
 *
 * Env:
 *   KUBE_CONTEXT   — kubectl context to use   (default: k3s-local)
 *   KUBE_NAMESPACE — namespace                (default: default)
 */

import { existsSync } from 'node:fs'
import { resolve, basename } from 'node:path'

// ── Args / env ────────────────────────────────────────────────────────────────

const backupArg = process.argv[2]

if (!backupArg) {
  console.error('Usage: bun scripts/restore.js <path-to-backup.db>')
  process.exit(1)
}

const backupPath = resolve(backupArg)

if (!existsSync(backupPath)) {
  console.error(`Backup file not found: ${backupPath}`)
  process.exit(1)
}

const CONTEXT   = process.env.KUBE_CONTEXT   ?? 'k3s-local'
const NAMESPACE = process.env.KUBE_NAMESPACE ?? 'default'
const DEPLOY    = 'chat-web'
const PVC       = 'chat-web-sqlite'
const DB_PATH   = '/var/lib/chat/chat.db'
const MOUNT     = '/var/lib/chat'
const HELPER    = `restore-helper-${Date.now()}`
const TMP_PATH  = `${MOUNT}/${basename(backupPath)}.restore-tmp`

// ── Helpers ───────────────────────────────────────────────────────────────────

async function run(label, args) {
  process.stdout.write(`  ${label} ... `)
  const proc = Bun.spawn(['kubectl', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    console.log('FAILED')
    console.error(stderr.trim() || stdout.trim())
    throw new Error(`kubectl ${args[0]} exited ${exitCode}`)
  }
  console.log('ok')
  return stdout.trim()
}

async function runSilent(args) {
  const proc = Bun.spawn(['kubectl', ...args], { stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
}

async function waitForPod(name) {
  process.stdout.write(`  waiting for pod/${name} ... `)
  for (let i = 0; i < 60; i++) {
    const proc = Bun.spawn(
      ['kubectl', '--context', CONTEXT, '-n', NAMESPACE,
       'get', 'pod', name, '-o', 'jsonpath={.status.phase}'],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    const phase = await new Response(proc.stdout).text()
    await proc.exited
    if (phase === 'Running') { console.log('ok'); return }
    await Bun.sleep(2000)
  }
  throw new Error(`Timed out waiting for pod/${name} to be Running`)
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

let helperStarted = false

async function cleanup() {
  if (!helperStarted) return
  process.stdout.write(`  deleting pod/${HELPER} ... `)
  await runSilent(['--context', CONTEXT, '-n', NAMESPACE, 'delete', 'pod', HELPER, '--ignore-not-found'])
  console.log('ok')
}

process.on('SIGINT',  async () => { await cleanup(); process.exit(130) })
process.on('SIGTERM', async () => { await cleanup(); process.exit(143) })

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\nRestore: ${backupPath}`)
console.log(`Context: ${CONTEXT}  Namespace: ${NAMESPACE}\n`)

try {
  // 1. Switch context
  await run('switch context', ['config', 'use-context', CONTEXT])

  // 2. Scale down
  await run(`scale ${DEPLOY} to 0`, [
    '-n', NAMESPACE, 'scale', 'deployment', DEPLOY, '--replicas=0'
  ])
  await run('wait for termination', [
    '-n', NAMESPACE, 'rollout', 'status', `deployment/${DEPLOY}`,
    '--timeout=60s'
  ])

  // 3. Start helper pod
  const overrides = JSON.stringify({
    spec: {
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: PVC } }],
      containers: [{
        name: HELPER,
        image: 'busybox',
        command: ['sleep', '3600'],
        volumeMounts: [{ name: 'data', mountPath: MOUNT }],
      }],
    },
  })

  helperStarted = true
  await run(`create pod/${HELPER}`, [
    '-n', NAMESPACE, 'run', HELPER,
    '--image=busybox', '--restart=Never',
    `--overrides=${overrides}`,
  ])
  await waitForPod(HELPER)

  // 4. Upload backup to pod
  await run(`upload ${basename(backupPath)}`, [
    '-n', NAMESPACE, 'cp', backupPath, `${HELPER}:${TMP_PATH}`,
  ])

  // 5. Move into place
  await run('replace database', [
    '-n', NAMESPACE, 'exec', HELPER,
    '--', 'cp', TMP_PATH, DB_PATH,
  ])

  // 6. Fix permissions so the app can write to the restored file
  await run('fix permissions', [
    '-n', NAMESPACE, 'exec', HELPER,
    '--', 'chmod', '666', DB_PATH,
  ])

  // 7. Remove stale WAL/SHM files so SQLite opens cleanly
  await run('remove stale WAL/SHM', [
    '-n', NAMESPACE, 'exec', HELPER,
    '--', 'sh', '-c', `rm -f ${DB_PATH}-wal ${DB_PATH}-shm`,
  ])

  // 8. Remove temp file
  await run('remove temp file', [
    '-n', NAMESPACE, 'exec', HELPER,
    '--', 'rm', TMP_PATH,
  ])

  // 9. Tear down helper
  await cleanup()
  helperStarted = false

  // 10. Scale back up
  await run(`scale ${DEPLOY} to 1`, [
    '-n', NAMESPACE, 'scale', 'deployment', DEPLOY, '--replicas=1'
  ])
  await run('wait for rollout', [
    '-n', NAMESPACE, 'rollout', 'status', `deployment/${DEPLOY}`,
    '--timeout=120s'
  ])

  console.log('\nRestore complete.')
} catch (err) {
  console.error(`\nRestore failed: ${err.message}`)
  await cleanup()

  // Attempt to bring the deployment back up so the service isn't left down
  console.log('\nAttempting to restore deployment replicas ...')
  await runSilent(['-n', NAMESPACE, 'scale', 'deployment', DEPLOY, '--replicas=1'])
    .catch(() => {})

  process.exit(1)
}
