import { useSuspenseQuery } from '@tanstack/react-query'

import { lineScoreDataQuery } from './line-score-data/line-score-data-query'
import { LineScoreDataDisplay } from './line-score-data/line-score-data-display'

interface LineScoreDataProps {
  matchId: string
}

export const LineScoreData = ({ matchId }: LineScoreDataProps) => {
  const { data: lineScoreData } = useSuspenseQuery(lineScoreDataQuery(matchId))

  return <LineScoreDataDisplay lineScoreData={lineScoreData} />
}
