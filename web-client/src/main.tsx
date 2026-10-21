import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createAppRouter } from './router.tsx'
import './styles/tokens.css'
import './styles/base.css'

const router = createAppRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
