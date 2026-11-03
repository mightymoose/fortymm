import { createFileRoute } from '@tanstack/react-router'
import { ResultLink } from '../pages/results/ResultLink'

export const Route = createFileRoute('/r')({
  component: ResultLink,
})
