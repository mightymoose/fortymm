// Runs before every component test file (vite.config.ts, `test.setupFiles`).
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { loadCore } from '../core/load.ts'
import { server } from './api/server.ts'

// The shared core: the real WebAssembly module and wrapper that core:wasm
// built, read from the core-cache volume (mounted at /opt/core by
// compose.dev.yaml). Only how the bytes arrive differs from src/core/load.ts,
// which fetches them. A test can make loading fail for itself with
// vi.mocked(loadCore).mockRejectedValue(...); afterEach puts this back.
// src/core/load.test.ts tests the real load.ts.
vi.mock('../core/load.ts', async () => {
  // Typed here: the app's tsconfig has no Node types, and this is the one
  // place in src/ that reads a file.
  const { readFile } = (await import('node:fs/promises' as string)) as {
    readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>
  }
  const { Core } = await import('fortymm-core/fortymm-core.mjs')
  const core = Core.load(await readFile('/opt/core/wasm/fortymm-core.wasm'))
  return { loadCore: vi.fn(() => core) }
})

// The router resets scroll on navigation; jsdom has no layout and only logs
// "Not implemented" for scrollTo.
window.scrollTo = () => {}

// Requests no handler answered during the current test. MSW makes each one
// fail with a network error, which the app may well turn into something on
// screen; afterEach then fails the test, so a missing handler is never
// mistaken for "the api could not be reached".
const unhandled: string[] = []

beforeAll(() => {
  server.listen({
    onUnhandledFrame({ frame, defaults }) {
      const data = frame.data as { request?: Request }
      unhandled.push(
        data.request
          ? `${data.request.method} ${data.request.url}`
          : frame.protocol,
      )
      defaults.error()
    },
  })
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
  // Back to the real core, read from disk (vi.mock above).
  vi.mocked(loadCore).mockReset()
  const sent = unhandled.splice(0)
  if (sent.length > 0) {
    throw new Error(
      `The test sent requests no MSW handler answered: ${sent.join(', ')}. ` +
        'Add a handler with server.use(...) (src/test/api/).',
    )
  }
})

afterAll(() => {
  server.close()
})
