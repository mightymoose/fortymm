import { createFileRoute } from '@tanstack/react-router'
import { AcceptResult } from '../../../../../../pages/matches/AcceptResult'

export const Route = createFileRoute('/_authenticated/matches/$matchId/scores/approvals/new')({
  component: AcceptResult,
})
