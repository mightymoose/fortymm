import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { configDefaults } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // It has to run before the React plugin.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    VitePWA({
      // src/serviceWorker.ts registers it, so tests and the dev server never do.
      injectRegister: false,
      manifest: false,
      workbox: {
        // The whole build is under 1 MB, so every chunk, style and font is
        // precached and a later navigation never waits on the network.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
        // These navigations must reach the Worker: the sign-in redirects and
        // the API's docs.
        navigateFallbackDenylist: [/^\/api\//],
        // No skipWaiting: a new worker would delete the precache of an open
        // tab, which then fails to load its next route chunk (#153). It
        // takes over once every tab of the old version has closed.
      },
    }),
  ],
  server: {
    // Listen on all interfaces so the dev server is reachable from outside
    // the Docker Compose container.
    host: true,
    port: 5173,
    strictPort: true,
    // The API has no published port: requests to /api/* are forwarded to the
    // `api` Compose service with the /api prefix stripped, so /api/v1/health
    // reaches its /v1/health.
    proxy: {
      '/api/': {
        target: process.env.API_PROXY_TARGET ?? 'http://api:8000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      // The mock OpenID Connect provider's sign-in page (the `oidc` Compose
      // service), which the browser can't reach by its Compose name.
      '/oidc/': {
        target: process.env.OIDC_PROXY_TARGET ?? 'http://oidc:8080',
        rewrite: (path) => path.replace(/^\/oidc/, ''),
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
