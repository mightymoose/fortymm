// Makes the builds web-client's browser suite (e2e/) deploys, from the
// production build in dist/, and deploys the current one:
//   e2e/.builds/current  dist as it is
//   e2e/.builds/next     dist deployed later: the page's title says
//                        "(next deployment)", and sw.js is rewritten by the
//                        same build step, so the browser sees a new version
//   e2e/.builds/harness  dist with a test-only page for the device key,
//                        /device-key.html (e2e/harness/)
//   e2e/.site            what web-client-preview serves; starts as current
// Run by web-client:e2e, in a web-client container, after web-client:build.
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'
import { writeServiceWorker } from '../offline/plugin.ts'

const builds = 'e2e/.builds'

await rm(builds, { recursive: true, force: true })
await rm('e2e/.site', { recursive: true, force: true })
await cp('dist', `${builds}/current`, { recursive: true })
await cp('dist', `${builds}/next`, { recursive: true })
await cp('dist', 'e2e/.site', { recursive: true })

const page = `${builds}/next/index.html`
const html = await readFile(page, 'utf8')
const next = html.replace('<title>fortymm</title>', '<title>fortymm (next deployment)</title>')
if (next === html) {
  throw new Error(`${page} has no <title>fortymm</title> to change`)
}
await writeFile(page, next)
await writeServiceWorker(`${builds}/next`)

// harness: dist with a test-only page, /device-key.html (e2e/harness/), that
// lets the suite call src/device-key.ts, which no screen uses yet. Built from
// the app's own modules, with the core aliased as vite.config.ts does, and
// its files under /harness/. sw.js is rewritten, so the page is kept on the
// device with the rest of the build and opens with no connection.
const harness = `${builds}/harness`
await cp('dist', harness, { recursive: true })
await build({
  configFile: false,
  root: resolve('e2e/harness'),
  logLevel: 'warn',
  resolve: { alias: { 'fortymm-core': '/opt/core/wasm' } },
  build: {
    outDir: resolve(harness),
    emptyOutDir: false,
    assetsDir: 'harness',
    rollupOptions: { input: resolve('e2e/harness/device-key.html') },
  },
})
await writeServiceWorker(harness)

console.log(`Builds for the browser suite are in ${builds}/; current is deployed.`)
