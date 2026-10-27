import { createFileRoute } from '@tanstack/react-router'
import { LoginGate2 } from '../pages/loginGate/LoginGate2'

export const Route = createFileRoute('/login-gate2')({
  component: LoginGate2,
})
