import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..')
const baseFile = resolve(repoRoot, 'docker-compose.dev.yml')
const overrideFile = resolve(repoRoot, 'docker-compose.e2e.yml')

export default async function globalTeardown() {
  if (process.env.E2E_BASE_URL) return
  if (process.env.E2E_KEEP_STACK) return

  spawnSync(
    'docker',
    ['compose', '-f', baseFile, '-f', overrideFile, 'down', '-v'],
    { stdio: 'inherit' },
  )
}
