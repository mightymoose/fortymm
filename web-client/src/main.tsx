import { QueryClient } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { land } from './device/land.ts'
import './index.css'
import { createAppRouter } from './router.ts'

// Dev server only: mock the api endpoints the api doesn't serve yet (src/mocks/dev-handlers.ts) and
// pass every other request to it. `import.meta.env.DEV` is false in a build, so the build has
// none of this, and msw's Vite plugin then leaves its worker script out too (see vite.config.ts).
if (import.meta.env.DEV) {
  const { network } = await import('virtual:msw')
  const { devHandlers } = await import('./mocks/dev-handlers.ts')
  network.configure({ handlers: devHandlers, onUnhandledFrame: 'bypass' })
  await network.enable()
}

const router = createAppRouter()
const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
)

// In the background, after the render has been asked for: the device's key and persistent storage.
void land()
