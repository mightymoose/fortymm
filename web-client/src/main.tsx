import { QueryClient } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { land } from './device/land.ts'
import './index.css'
import { createAppRouter } from './router.ts'

const router = createAppRouter()
const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
)

// In the background, after the render has been asked for: the device's key and persistent storage.
void land()
