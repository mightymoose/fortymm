// Makes the builds web-client's browser suite (e2e/) deploys, from the
// production build in dist/, and deploys the current one:
//   e2e/.builds/current  dist as it is
//   e2e/.builds/next     dist deployed later: the page's title says
//                        "(next deployment)", and sw.js is rewritten by the
//                        same build step, so the browser sees a new version
//   e2e/.site            what web-client-preview serves; starts as current
// Run by web-client:e2e, in a web-client container, after web-client:build.
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
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

console.log(`Builds for the browser suite are in ${builds}/; current is deployed.`)
