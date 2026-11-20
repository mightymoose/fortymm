import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './theme/theme.css'
import { keepAppOnDevice } from './keep-on-device.ts'
import { keeping } from './persist.ts'
import { createAppRouter } from './router.ts'
import { userStore } from './stores/user.ts'

const router = createAppRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)

keepAppOnDevice()

// The first launch (src/first-launch.ts), through the user store, in the
// background: the first paint never waits for it.
void userStore.getState().launch()

// A device with matches the browser hasn't promised to keep asks again
// (src/persist.ts), in the background, quietly.
void keeping.onStart()
