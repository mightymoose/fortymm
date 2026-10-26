import { createFileRoute } from '@tanstack/react-router'
import { SignedOut } from '../pages/SignedOut'

export const Route = createFileRoute('/signed-out')({
  component: SignedOut,
})
