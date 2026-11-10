import { createRouter, type RouterHistory } from '@tanstack/react-router'
// Generated from the files in src/routes by the TanStack Router Vite plugin.
import { routeTree } from './routeTree.gen.ts'

// The one place the router is configured. main.tsx calls it with the browser's
// history; component tests call it (through src/test/render-route.tsx) with an
// in-memory history, so they mount the same routes the app does.
export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({ routeTree, ...options })
}

// Registers the router's routes with the type checker, so a <Link> or
// navigate() to a path that has no route file fails `tsc -b`.
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
