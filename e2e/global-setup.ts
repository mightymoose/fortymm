import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const repoRoot = resolve(__dirname, '..')
const baseFile = resolve(repoRoot, 'docker-compose.dev.yml')
const overrideFile = resolve(repoRoot, 'docker-compose.e2e.yml')

const NGINX_PORT = process.env.E2E_NGINX_PORT ?? '18080'
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${NGINX_PORT}`

// Docker compose `--wait` only gates on declared healthchecks. The web-client
// service has none, so the container is considered ready as soon as the
// process starts — well before Vite's first compile finishes. Without this
// probe the first test request races Vite's JIT transforms and times out.
async function waitForReady(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (response.status < 500) return
      lastError = new Error(`status ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for ${url} to respond: ${String(lastError)}`)
}

export default async function globalSetup() {
  if (process.env.E2E_BASE_URL) return

  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f', baseFile,
      '-f', overrideFile,
      'up', '-d', '--wait', '--build',
    ],
    { stdio: 'inherit' },
  )

  if (result.status !== 0) {
    throw new Error(`docker compose up failed with exit code ${result.status}`)
  }

  await waitForReady(BASE_URL, 120_000)
}
