import { Outlet } from '@tanstack/react-router'
import { ToastProvider } from '../components/ToastProvider'
import { TooltipProvider } from '../components/TooltipProvider'

// Gives every page toasts and tooltips. Each page brings its own frame: the
// authenticated pages sit in AppShell, and the design system page in
// `.page` (styles/page.css).
export function Root() {
  return (
    <ToastProvider>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </ToastProvider>
  )
}
