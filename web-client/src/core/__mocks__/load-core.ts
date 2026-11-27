/// <reference types="node" />
// The core as unit tests see it (setupTests.ts mocks ../load-core.ts with this). jsdom has no fetch
// for file URLs, which init() would use, so the .wasm is loaded from disk instead. A test makes the
// load fail with `vi.mocked(loadCore).mockRejectedValueOnce(...)`.
import { readFileSync } from 'node:fs'
import { hello_world, initSync } from 'fortymm-core-wasm'
import { vi } from 'vitest'
import type { Core } from '../load-core.ts'

let core: Core | undefined

export const loadCore = vi.fn(async (): Promise<Core> => {
  if (!core) {
    initSync({ module: readFileSync('node_modules/fortymm-core-wasm/fortymm_core_wasm_bg.wasm') })
    core = { hello_world }
  }
  return core
})
