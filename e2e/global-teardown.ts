import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { clearMerchantAccountState } from './support/merchant-checkout'

const repoRoot = resolve(__dirname, '..')
const baseFile = resolve(repoRoot, 'docker-compose.dev.yml')
const overrideFile = resolve(repoRoot, 'docker-compose.e2e.yml')

export default async function globalTeardown() {
  // Idempotent and safe even when nothing was ever provisioned (e.g.
  // `E2E_BASE_URL` skipped `global-setup.ts` entirely) — run it unconditionally
  // rather than duplicating the two early-returns below.
  clearMerchantAccountState()

  if (process.env.E2E_BASE_URL) return
  if (process.env.E2E_KEEP_STACK) return

  spawnSync(
    'docker',
    ['compose', '-f', baseFile, '-f', overrideFile, 'down', '-v'],
    { stdio: 'inherit' },
  )
}
