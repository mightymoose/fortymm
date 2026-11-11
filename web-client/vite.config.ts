import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Generates src/routeTree.gen.ts from the files in src/routes: on dev
    // server start, on every route file change, and on build. Must come before
    // the React plugin. Generator options belong in tsr.config.json, which
    // this plugin and `tsr generate` (web-client:routes-check) both read, so
    // both write the same file.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
  ],
  // The dev server forwards /api/* to the api, stripping /api, the way the
  // production hosting does (see src/api/client.ts). The target is the api
  // service on the dev stack's network (compose.dev.yaml); if it isn't running,
  // the page says the api's health is unknown.
  // The core's browser build, made by core:wasm into the core-cache volume
  // and mounted read-only at /opt/core (compose.dev.yaml): the wrapper
  // `fortymm-core/fortymm-core.mjs` and the module with cryptography
  // `fortymm-core/crypto.wasm`. The build bundles both into dist.
  resolve: {
    alias: { 'fortymm-core': '/opt/core/wasm' },
  },
  server: {
    fs: { allow: ['.', '/opt/core/wasm'] },
    proxy: {
      '/api': {
        target: 'http://api:8000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  // Component tests (web-client:test): src/**/*.test.tsx, in jsdom.
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
