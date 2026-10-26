import { createFileRoute } from '@tanstack/react-router'
import { SignedOutGuestFirst } from '../pages/signedOut/SignedOutDesigns'

export const Route = createFileRoute('/signed-out-3')({
  component: SignedOutGuestFirst,
})
