import { Core } from 'fortymm-core/fortymm-core.mjs'
import moduleUrl from 'fortymm-core/fortymm-core.wasm?url'

// The shared core (core/, the Rust library), as its browser build: the
// WebAssembly module and its hand-written wrapper, which core:wasm builds
// (vite.config.ts says where they are). The production build emits the module
// into dist/assets, so the service worker keeps it with every other file.
//
// Fetched and instantiated once per page, however many callers ask: every
// caller gets the same Core. A load that fails (no connection before the app
// was kept, a broken deployment) is forgotten, so the next caller tries again.
// The wrapper's methods are synchronous once it has loaded.
//
// Component tests replace this module with one that reads the same module from
// disk (src/test/setup.ts), except load.test.ts, which tests this one.
let loading: Promise<Core> | undefined

export function loadCore(): Promise<Core> {
  loading ??= fetchCore().catch((error: unknown) => {
    loading = undefined
    throw error
  })
  return loading
}

async function fetchCore(): Promise<Core> {
  const url = new URL(moduleUrl, document.baseURI)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`The core's module at ${url.pathname} answered ${response.status}`)
  }
  return Core.load(await response.arrayBuffer())
}
