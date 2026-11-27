import { queryOptions } from '@tanstack/react-query'
import { loadCore } from '../core/load-core.ts'

// Whether the core works in this browser: its wasm loads, and it answers as it should. Errors if
// the wasm can't be fetched or instantiated.
export const webCoreHealthQuery = queryOptions({
  queryKey: ['web-core-health'],
  queryFn: async () => {
    const core = await loadCore()
    return core.hello_world() === 'Hello World'
  },
})
