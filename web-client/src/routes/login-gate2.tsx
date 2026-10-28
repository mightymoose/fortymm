import { createFileRoute } from '@tanstack/react-router'
import { LoginGate2 } from '../pages/loginGate/LoginGate2'

export const Route = createFileRoute('/login-gate2')({
  // `frame` names one frame to show full screen, such as `?frame=step-2`.
  validateSearch: (search: Record<string, unknown>): { frame?: string } =>
    typeof search.frame === 'string' ? { frame: search.frame } : {},
  component: LoginGate2,
})
