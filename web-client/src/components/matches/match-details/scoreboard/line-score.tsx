import { Suspense } from 'react'

import { LineScoreData } from './line-score/line-score-data'
import { LineScoreSkeleton } from './line-score/line-score-skeleton'

interface LineScoreProps {
  matchId: string
}

export function LineScore({ matchId }: LineScoreProps) {
  return (
    <Suspense fallback={<LineScoreSkeleton />}>
      <LineScoreData matchId={matchId} />
    </Suspense>
  )
}
