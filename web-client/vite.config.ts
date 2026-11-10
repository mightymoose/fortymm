import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Generates src/routeTree.gen.ts from the files in src/routes: on dev
    // server start, on every route file change, and on build. Must come before
    // the React plugin. Leave the paths at their defaults: `tsr generate` (the
    // route tree check, web-client:routes-check) uses them too, so both write
    // the same file.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
  ],
})
