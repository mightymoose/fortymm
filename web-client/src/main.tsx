import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createAppRouter } from './router.tsx'
import { createAppUpdate } from './serviceWorker.ts'
import './styles/tokens.css'
import './styles/base.css'
import './styles/kit.css'
import './styles/page.css'

// vite-plugin-pwa writes /sw.js only in a build, so the dev server has none.
const appUpdate = createAppUpdate(
  import.meta.env.PROD && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
)
const router = createAppRouter(undefined, { appUpdate })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)

void appUpdate.register()
