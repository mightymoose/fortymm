import { defineConfig } from 'orval'

// Typed fetch functions and their types from the api's OpenAPI spec, nothing else (no query hooks,
// zod or mocks). `./bin/mise run web-client:api-client` regenerates; verify checks it is current.
export default defineConfig({
  api: {
    input: '../api/openapi.json',
    output: {
      // verify points ORVAL_TARGET elsewhere and diffs it against the committed file.
      target: process.env.ORVAL_TARGET ?? 'src/api/generated.ts',
      client: 'fetch',
      mode: 'single',
    },
  },
})
