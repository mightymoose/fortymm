import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

// The hosting checks (project worker) are about this checkout's build, the
// one in web-client/dist (mounted at /build by compose.dev.yaml): run by the
// e2e task against the local Workers runtime serving it, or by
// web-client:deploy against the address it just deployed it to. So before
// any of them, the address must serve that build. Otherwise they would test
// something else: a previous deployment, or, before a new Worker is live on
// workers.dev, Cloudflare's own 404 (error code 1042).
//
// A deployment reaches Cloudflare's edge some time after `wrangler deploy`
// returns, so this waits for it, up to `deployed`. The local Workers runtime
// serves the build at once.
const buildPage = '/build/index.html'
const deployed = 120_000

test('the address serves this checkout’s build', async ({ request }) => {
  test.setTimeout(deployed + 30_000)
  const expected = await readFile(buildPage, 'utf8')

  await expect(async () => {
    const response = await request.get('/index.html')

    expect(response.status()).toBe(200)
    expect(await response.text()).toBe(expected)
  }).toPass({ timeout: deployed, intervals: [1_000, 2_000, 5_000] })
})
