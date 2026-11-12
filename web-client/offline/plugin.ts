import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { transformWithOxc, type Plugin } from 'vite'

// Writes the service worker (offline/service-worker.ts) into the production
// build as sw.js, with the list of every file the build emitted, so the
// browser keeps the whole app on the device after one visit. Build only: the
// dev server has no sw.js, and the app registers it only in production
// (src/keep-on-device.ts).

// Served at the root, so the worker's scope is the whole app.
export const serviceWorkerFile = 'sw.js'

const workerSource = join(import.meta.dirname, 'service-worker.ts')

// Every file in the built output, as the path the browser requests
// ('/index.html', '/assets/index-1a2b3c.js'), except the worker itself. Read
// from the disk once the build is written, so it holds everything: the page,
// every chunk (screens not opened yet too), styles, images, .wasm files, and
// what public/ copied in.
export async function keptFiles(outDir: string): Promise<string[]> {
  const entries = await readdir(outDir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(outDir, join(entry.parentPath, entry.name)).split(sep).join('/'),
    )
    .filter((path) => path !== serviceWorkerFile)
    .sort()
    .map((path) => `/${path}`)
}

// Writes outDir/sw.js for the build in outDir. Its version is a hash of every
// kept file and of the worker's code, so any change to the build changes
// sw.js, which is how the browser learns of a new deployment.
export async function writeServiceWorker(outDir: string): Promise<void> {
  const files = await keptFiles(outDir)
  const { code } = await transformWithOxc(
    await readFile(workerSource, 'utf8'),
    workerSource,
    { lang: 'ts' },
  )
  const hash = createHash('sha256').update(code)
  for (const file of files) {
    hash.update(`\0${file}\0`).update(await readFile(join(outDir, file)))
  }
  const build = { version: hash.digest('hex').slice(0, 16), files }
  await writeFile(
    join(outDir, serviceWorkerFile),
    `const BUILD = ${JSON.stringify(build)};\n${code}`,
  )
}

export function keepOnDevice(): Plugin {
  let outDir = ''
  return {
    name: 'fortymm:keep-on-device',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    // After everything, public/ included, is written.
    async closeBundle() {
      await writeServiceWorker(outDir)
    },
  }
}
