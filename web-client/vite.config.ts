import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on all interfaces so the dev server is reachable from outside
    // the Docker Compose container.
    host: true,
    port: 5173,
    strictPort: true,
    // The API has no published port: requests to /api/* are forwarded to the
    // `api` Compose service with the /api prefix stripped, so /api/v1/ping
    // reaches its /v1/ping.
    proxy: {
      '/api/': {
        target: process.env.API_PROXY_TARGET ?? 'http://api:8000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    // e2e/ holds the Playwright suite, run by `npm run test:e2e`.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
