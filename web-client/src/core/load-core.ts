import init, { hello_world } from 'fortymm-core-wasm'

// The core's functions, once its wasm has loaded. Only these work before init() resolves: calling
// the package's exports directly before then throws.
export interface Core {
  hello_world: () => string
}

let loading: Promise<Core> | undefined

// Fetches and instantiates the core's .wasm (Vite serves it and resolves its URL) the first time,
// then shares that load. A failed load is forgotten, so the next call tries again.
export function loadCore(): Promise<Core> {
  loading ??= init().then(
    () => ({ hello_world }),
    (error: unknown) => {
      loading = undefined
      throw error
    },
  )
  return loading
}
