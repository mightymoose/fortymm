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
async function waitForReady(
  url: string,
  timeoutMs: number,
  options: { sleepMs?: number; check?: (res: Response) => Promise<boolean> } = {},
) {
  const { sleepMs = 1000, check } = options
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      const ok = check ? await check(response) : response.status < 500
      if (ok) return
      lastError = new Error(`status ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(sleepMs)
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
  // `--wait` only gates on each container's own healthcheck, so the api is
  // marked healthy as soon as it answers its internal probe — but nginx can
  // still 502 the `/api` upstream for a beat after startup (the api isn't yet
  // resolvable/accepting through the proxy). The app fires `GET /v1/session`
  // immediately on load and hangs its session loader if that races the 502
  // window, so also gate on the API *through nginx* before running tests.
  //
  // A second race: the RQ worker may not have subscribed to the `solver` queue
  // yet when /v1/health first responds. The health endpoint enqueues a CP-SAT
  // probe job — if no worker is listening, it waits 10 s and returns
  // solver.healthy: false. The admin-system-health test hits that state and
  // locks to it (staleTime: 0, retry: false, no refetchInterval). Poll until
  // solver.healthy is true so all workers are definitely up before tests run.
  await waitForReady(`${BASE_URL}/api/v1/health`, 120_000, {
    sleepMs: 2000,
    check: async (res) => {
      if (!res.ok) return false
      const body = await res.json() as { solver?: { healthy?: boolean } }
      return body.solver?.healthy === true
    },
  })
}
