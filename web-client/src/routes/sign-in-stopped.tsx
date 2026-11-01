import { createFileRoute } from '@tanstack/react-router'
import { SignInStopped } from '../pages/SignInStopped'

export const Route = createFileRoute('/sign-in-stopped')({
  component: SignInStopped,
})
