import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './theme/theme.css'
import { launchAtStartup } from './first-launch.ts'
import { keepAppOnDevice } from './keep-on-device.ts'
import { createAppRouter } from './router.ts'

const router = createAppRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)

keepAppOnDevice()

// In the background: the first paint never waits for it.
void launchAtStartup()
