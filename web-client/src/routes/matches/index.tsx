import { createFileRoute } from '@tanstack/react-router'
import { MatchList } from '../../components/MatchList.tsx'
import { MatchListScreenPending } from '../../components/match-list/MatchListScreen.tsx'
import { matchesStore } from '../../stores/matches.ts'

export const Route = createFileRoute('/matches/')({
  loader: () => matchesStore.getState().load(),
  pendingComponent: MatchListScreenPending,
  component: MatchList,
})
