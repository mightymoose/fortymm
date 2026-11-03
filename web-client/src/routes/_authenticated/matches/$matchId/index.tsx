import { createFileRoute } from '@tanstack/react-router'
import { MatchPage } from '../../../../pages/matches/MatchPage'

export const Route = createFileRoute('/_authenticated/matches/$matchId/')({
  component: MatchPage,
})
