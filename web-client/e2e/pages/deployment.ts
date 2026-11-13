import { cp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

// The builds this suite can deploy, made by web-client:e2e
// (../scripts/e2e-deployments.ts) from the production build:
// - current: the build as it is.
// - next:    the same build, deployed later: its page's title says
//            "(next deployment)", and its sw.js is rewritten for it, so the
//            browser sees a new version.
// - harness: the build with test-only pages, /device-key.html and
//            /storage.html, through which a test calls the device key and
//            storage modules (../harness/).
export type Build = 'current' | 'next' | 'harness'

const builds = '.builds'
// What web-client-preview serves. It reads the files on every request, so
// replacing them is a deployment.
const site = '.site'

export async function deploy(build: Build) {
  for (const entry of await readdir(site)) {
    await rm(join(site, entry), { recursive: true, force: true })
  }
  await cp(join(builds, build), site, { recursive: true })
}
