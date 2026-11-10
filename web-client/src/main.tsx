import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import './index.css'
// Generated from the files in src/routes by the TanStack Router Vite plugin.
import { routeTree } from './routeTree.gen.ts'

const router = createRouter({ routeTree })

// Registers the router's routes with the type checker, so a <Link> or
// navigate() to a path that has no route file fails `tsc -b`.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
