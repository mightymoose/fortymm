import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

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
    allowedHosts: ['.ts.net'],
  },
})
