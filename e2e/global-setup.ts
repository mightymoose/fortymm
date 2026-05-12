import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..')
const baseFile = resolve(repoRoot, 'docker-compose.dev.yml')
const overrideFile = resolve(repoRoot, 'docker-compose.e2e.yml')

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
}
