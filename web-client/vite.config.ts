import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { keepOnDevice } from './offline/plugin.ts'

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
    // Build only: writes dist/sw.js, which keeps the whole build on the device
    // (offline/plugin.ts).
    keepOnDevice(),
  ],
  // The core's browser build, which core:wasm writes to the core-cache volume,
  // mounted read-only at /opt/core (compose.dev.yaml): the app imports the
  // wrapper as `fortymm-core/fortymm-core.mjs` and the module's URL as
  // `fortymm-core/fortymm-core.wasm?url` (src/core/load.ts). The build emits
  // the module into dist/assets. tsconfig.app.json maps the same name for the
  // type checker.
  resolve: {
    alias: { 'fortymm-core': '/opt/core/wasm' },
  },
  server: {
    // The dev server serves files outside the app only from where it's told.
    fs: { allow: ['.', '/opt/core/wasm'] },
    // The dev server forwards /api/* to the api, stripping /api, the way the
    // production hosting does (see src/api/client.ts). The target is the api
    // service on the dev stack's network (compose.dev.yaml); if it isn't
    // running, the page says the api's health is unknown.
    proxy: {
      '/api': {
        target: 'http://api:8000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  // Component tests (web-client:test): src/**/*.test.tsx, in jsdom; and the
  // build step's tests, offline/*.test.ts.
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'offline/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
