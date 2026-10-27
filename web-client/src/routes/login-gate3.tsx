import { createFileRoute } from '@tanstack/react-router'
import { LoginGate3 } from '../pages/loginGate/LoginGate3'

export const Route = createFileRoute('/login-gate3')({
  component: LoginGate3,
})
