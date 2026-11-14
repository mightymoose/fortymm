import { cp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext } from '@playwright/test'

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

// The network between the browser and a deployment, as the service worker
// sees it while it downloads a new build to keep. Only the worker's own
// requests are touched: the page's go on as before.
function byTheWorker(path: string) {
  return (url: URL) => url.pathname === path
}

// Holds back `path` ('/index.html') from the service worker until
// release(): its install can't finish before then. `requested` settles when
// the worker has asked for it.
export async function holdBack(context: BrowserContext, path: string) {
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  let asked = () => {}
  const requested = new Promise<void>((resolve) => (asked = resolve))
  await context.route(byTheWorker(path), async (route) => {
    if (route.request().serviceWorker() === null) return route.fallback()
    asked()
    await released
    await route.fallback()
  })
  return { requested, release }
}

// Makes the service worker's download of `path` fail, as a dropped
// connection does, until stop(): `failed` settles once one has.
export async function failDownload(context: BrowserContext, path: string) {
  let failing = true
  let fail = () => {}
  const failed = new Promise<void>((resolve) => (fail = resolve))
  await context.route(byTheWorker(path), async (route) => {
    if (!failing || route.request().serviceWorker() === null) {
      return route.fallback()
    }
    await route.abort('internetdisconnected')
    fail()
  })
  return {
    failed,
    stop() {
      failing = false
    },
  }
}
