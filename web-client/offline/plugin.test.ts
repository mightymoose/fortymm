import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { writeServiceWorker } from './plugin.ts'

let outDir = ''

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'keep-on-device-'))
})

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true })
})

// A build output like Vite's, with a WebAssembly file such as the core
// library's will be.
async function emit(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(outDir, path)), { recursive: true })
    await writeFile(join(outDir, path), content)
  }
}

// What the browser gets: BUILD, written in front of the worker in sw.js.
async function builtWorker(): Promise<{ version: string; files: string[] }> {
  const sw = await readFile(join(outDir, 'sw.js'), 'utf8')
  const match = /^const BUILD = (.*);$/m.exec(sw)
  if (!match) throw new Error('sw.js does not start with BUILD')
  return JSON.parse(match[1])
}

const build = {
  'index.html': '<!doctype html>',
  'assets/index-a1.js': 'app',
  'assets/health-b2.js': 'a screen not opened yet',
  'assets/index-c3.css': 'styles',
  'assets/hero-d4.png': 'image',
  'assets/fortymm_core_bg-e5.wasm': 'core',
  'manifest.webmanifest': '{}',
  'icons/icon-192.png': 'icon',
}

test('the kept set is every file the build emitted, .wasm included, and not sw.js itself', async () => {
  await emit(build)

  await writeServiceWorker(outDir)

  expect((await builtWorker()).files).toEqual([
    '/assets/fortymm_core_bg-e5.wasm',
    '/assets/health-b2.js',
    '/assets/hero-d4.png',
    '/assets/index-a1.js',
    '/assets/index-c3.css',
    '/icons/icon-192.png',
    '/index.html',
    '/manifest.webmanifest',
  ])
})

test('a build whose files changed gets a new version, so the browser installs it', async () => {
  await emit(build)
  await writeServiceWorker(outDir)
  const before = await builtWorker()

  await emit({ 'assets/fortymm_core_bg-e5.wasm': 'core, changed' })
  await writeServiceWorker(outDir)

  expect((await builtWorker()).version).not.toBe(before.version)
})
