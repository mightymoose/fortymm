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
  // Component tests (web-client:test): src/**/*.test.tsx, in jsdom.
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
