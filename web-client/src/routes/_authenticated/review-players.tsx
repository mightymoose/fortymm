import { createFileRoute } from '@tanstack/react-router'
import { PlayerReview } from '../../pages/adoption/PlayerReview'

export const Route = createFileRoute('/_authenticated/review-players')({
  component: PlayerReview,
})
