import { createFileRoute } from '@tanstack/react-router'
import { MatchList } from '../../components/MatchList.tsx'

export const Route = createFileRoute('/matches/')({
  component: MatchList,
})
