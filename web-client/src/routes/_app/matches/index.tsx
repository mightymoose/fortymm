import { createFileRoute } from '@tanstack/react-router'
import { MatchesScreen } from '../../../components/MatchesScreen.tsx'

export const Route = createFileRoute('/_app/matches/')({
  component: MatchesScreen,
})
