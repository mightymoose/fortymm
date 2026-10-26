import { createFileRoute } from '@tanstack/react-router'
import { SignedOutScreen } from '../pages/signedOut/SignedOutDesigns'

export const Route = createFileRoute('/signed-out-1')({
  component: SignedOutScreen,
})
