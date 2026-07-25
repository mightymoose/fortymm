/// <reference types="vitest/config" />
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      // Test files colocated next to their route (e.g. routes/matches/
      // new.test.tsx) aren't routes — keep the generator from scanning them.
      routeFileIgnorePattern: '\\.test\\.[jt]sx?$',
    }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallbackDenylist: [/^\/api/, /^\/mockServiceWorker\.js$/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
      },
      manifest: {
        name: 'FortyMM',
        short_name: 'FortyMM',
        description: 'Table tennis match tracker and tournament platform.',
        theme_color: '#0B0D12',
        background_color: '#0B0D12',
        icons: [
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_PROXY ?? 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
      },
    },
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // Must stay STRICTLY GREATER than Testing Library's `asyncUtilTimeout`
    // (5000, set in src/test/setup.ts). Left at vitest's 5000 default the two
    // budgets are equal, so a slow `waitFor` and the test itself expire at the
    // same instant and the failure surfaces as an undiagnosable
    // "Test timed out in 5000ms" instead of Testing Library's "Unable to find
    // <element>". Raising the outer bound fixes that for all ~410 `waitFor`
    // call sites at once; only 4 pass a timeout of their own.
    testTimeout: 10000,
    // Dates render in the reader's LOCAL zone (a match is played on a local day),
    // so an unpinned runner would date the same fixture differently on a laptop in
    // Chicago and on a CI box in UTC. Pin the suite to one zone — the one CI
    // already runs in — so a test that asserts a literal day label ("May 9") is
    // reading a fixture, not the machine.
    //
    // Do NOT reach for `vi.stubEnv('TZ', …)` to write a test that is *about* the
    // local/UTC split. A mid-test `process.env.TZ` override takes under plain vitest
    // but NOT under Stryker's vitest runner, so such a test passes here and fails the
    // mutation job's initial dry run — which is a red build for a green app. **Inject
    // the zone instead**: the projection takes an optional `timeZone` (production
    // omits it, which is what `Intl` reads as "the reader's zone"), and the test names
    // one explicitly. See `selectWhen` in recent-matches-query.ts and its test, which
    // reads one instant from two zones and so depends on no ambient state at all.
    env: { TZ: 'UTC' },
    // Unit tests live under src/; Playwright specs under e2e/ are a separate
    // suite. Scope include explicitly so runners that don't honor `exclude`
    // (e.g. Stryker's sandboxed vitest) never try to run the .spec.ts e2e files.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
})
