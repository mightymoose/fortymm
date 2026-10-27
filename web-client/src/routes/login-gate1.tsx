import { createFileRoute } from '@tanstack/react-router'
import { LoginGate1 } from '../pages/loginGate/LoginGate1'

export const Route = createFileRoute('/login-gate1')({
  component: LoginGate1,
})
