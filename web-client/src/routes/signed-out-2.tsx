import { createFileRoute } from '@tanstack/react-router'
import { SignedOutCard } from '../pages/signedOut/SignedOutDesigns'

export const Route = createFileRoute('/signed-out-2')({
  component: SignedOutCard,
})
