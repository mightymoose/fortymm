import { createFileRoute } from '@tanstack/react-router'
import { NewMatch } from '../../components/NewMatch.tsx'

export const Route = createFileRoute('/matches/new')({
  component: NewMatch,
})
