import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { searchForWorkspaceRoot } from 'vite'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Must come before react().
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
  ],
  // Runs in a container (see docker-compose.yml): listen on all interfaces at a fixed
  // container port. Docker maps it to a random host port.
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // Tailscale Funnel serves the dev server at fortymm.<tailnet>.ts.net (see the preview task).
    // The verify task's e2e tests reach it on the compose network as http://web-client:5173.
    allowedHosts: ['.ts.net', 'web-client'],
    // The api serves its routes under /api, so requests pass through unchanged. It is the `api`
    // service on the compose network; preview's web-client-public sets API_URL to api-public.
    proxy: {
      '/api': process.env.API_URL ?? 'http://api:8000',
    },
    // fortymm-core-wasm is a file: link to ../core/bindings/wasm/pkg, outside the project, so its
    // .wasm (fetched by init()) would be refused without this.
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), '../core/bindings/wasm/pkg'],
    },
  },
  // Unit tests (Vitest) sit next to the code they test as *.test.ts(x); e2e/ is Playwright's.
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/setupTests.ts'],
  },
})
