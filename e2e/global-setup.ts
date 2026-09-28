import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { provisionMerchantAccount } from './support/merchant-checkout'

const repoRoot = resolve(__dirname, '..')
const baseFile = resolve(repoRoot, 'docker-compose.dev.yml')
const overrideFile = resolve(repoRoot, 'docker-compose.e2e.yml')

const NGINX_PORT = process.env.E2E_NGINX_PORT ?? '18080'
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${NGINX_PORT}`

/** Poll `GET {BASE_URL}/api/v1/health` until the RQ `solver` worker has
 * subscribed — see the call sites below for why this, and `waitForReady`
 * itself, must run twice. */
async function waitForSolverHealthy() {
  await waitForReady(`${BASE_URL}/api/v1/health`, 120_000, {
    sleepMs: 2000,
    check: async (res) => {
      if (!res.ok) return false
      const body = (await res.json()) as { solver?: { healthy?: boolean } }
      return body.solver?.healthy === true
    },
  })
}

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
  await waitForSolverHealthy()

  // Paid tournament checkout (#1809): pin `TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID`
  // to one real, server-minted Account id so `tests/tournament-checkout.spec.ts`
  // has a tournament owner `checkout_available` says yes to. See
  // `support/merchant-checkout.ts` for why this can only happen after boot.
  //
  // This whole block runs once here, before any test starts and before
  // Playwright's `fullyParallel` workers exist — never from a spec. Recreating
  // `api`/`worker` mid-suite, while unrelated specs hold open `/v1/stream`
  // connections or are mid-request through nginx, would cut them (nginx's
  // `upstream` blocks are resolved once, at nginx's own startup — see the
  // restart below) and flake or fail every test running at that moment, not
  // just this one. Doing it here instead costs a one-time delay all tests pay
  // and nobody's isolation.
  const merchant = await provisionMerchantAccount(BASE_URL)

  const recreate = spawnSync(
    'docker',
    [
      'compose',
      '-f', baseFile,
      '-f', overrideFile,
      'up', '-d', '--no-deps', '--force-recreate', 'api', 'worker',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID: merchant.accountId,
      },
    },
  )
  if (recreate.status !== 0) {
    throw new Error(
      `docker compose recreate (api, worker) with the merchant account pinned ` +
        `failed with exit code ${recreate.status}`,
    )
  }

  // Recreating api/worker gives them fresh container IPs. nginx resolved the
  // OLD ones into its static `upstream` blocks (`nginx/dev.conf` — no
  // `resolver` directive, so it never re-resolves) at ITS OWN startup, and is
  // otherwise untouched by the recreate above — exactly the persistent-502
  // trap this file's own header comment and `e2e/CLAUDE.md`'s gotchas
  // document for a second `up --build` on top of an existing stack. Restart it
  // now, before any test runs, the same remedy that trap names.
  const nginxRestart = spawnSync(
    'docker',
    ['compose', '-f', baseFile, '-f', overrideFile, 'restart', 'nginx'],
    { stdio: 'inherit' },
  )
  if (nginxRestart.status !== 0) {
    throw new Error(
      `docker compose restart nginx (after the merchant-pinned recreate) ` +
        `failed with exit code ${nginxRestart.status}`,
    )
  }

  // api, worker AND nginx are all new processes now — both readiness gates
  // again, for the exact races they exist to close (see above).
  await waitForReady(BASE_URL, 120_000)
  await waitForSolverHealthy()
}
