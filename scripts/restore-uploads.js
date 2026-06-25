#!/usr/bin/env bun
/**
 * Restore an uploads backup to the Kubernetes cluster.
 *
 * Copies a local uploads directory into the chat-web-sqlite PVC via a
 * temporary helper pod. The deployment is NOT scaled down — uploads are
 * static files and the copy is safe against a live server.
 *
 * Usage:
 *   bun scripts/restore-uploads.js <path-to-uploads-dir>
 *   bun restore-uploads ../uploads-backup
 *
 * Env:
 *   KUBE_CONTEXT   — kubectl context to use   (default: k3d-local)
 *   KUBE_NAMESPACE — namespace                (default: default)
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ── Args / env ────────────────────────────────────────────────────────────────

const uploadsArg = process.argv[2]

if (!uploadsArg) {
  console.error('Usage: bun scripts/restore-uploads.js <path-to-uploads-dir>')
  process.exit(1)
}

const uploadsPath = resolve(uploadsArg)

if (!existsSync(uploadsPath)) {
  console.error(`Uploads directory not found: ${uploadsPath}`)
  process.exit(1)
}

const CONTEXT   = process.env.KUBE_CONTEXT   ?? 'k3d-local'
const NAMESPACE = process.env.KUBE_NAMESPACE ?? 'default'
const PVC       = 'chat-web-sqlite'
const MOUNT     = '/var/lib/chat'
const UPLOADS   = `${MOUNT}/uploads`
const HELPER    = `uploads-restore-${Date.now()}`

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

console.log(`\nRestore uploads: ${uploadsPath}`)
console.log(`Context: ${CONTEXT}  Namespace: ${NAMESPACE}\n`)

try {
  // 1. Switch context
  await run('switch context', ['config', 'use-context', CONTEXT])

  // 2. Start helper pod
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

  // 3. Copy uploads into PVC
  await run('copy uploads', [
    '-n', NAMESPACE, 'cp', uploadsPath, `${HELPER}:${UPLOADS}`,
  ])

  // 4. Tear down helper
  await cleanup()
  helperStarted = false

  console.log('\nUploads restore complete.')
} catch (err) {
  console.error(`\nRestore failed: ${err.message}`)
  await cleanup()
  process.exit(1)
}
