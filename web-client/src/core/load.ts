import { Core } from 'fortymm-core/fortymm-core.mjs'
import wasmUrl from 'fortymm-core/crypto.wasm?url'

// The core's WebAssembly build, with cryptography, loaded once per page. The
// file is the one core:wasm builds (vite.config.ts says where it is); the
// build emits it into dist next to the bundle. Component tests replace this
// module with one that reads the same file from disk (src/test/setup.ts):
// jsdom cannot fetch it.
let loading: Promise<Core> | undefined

export function loadCore(): Promise<Core> {
  loading ??= fetch(wasmUrl)
    .then((response) => response.arrayBuffer())
    .then((bytes) => Core.load(bytes))
  return loading
}
