import type { LineScoreData } from './line-score-data-query'
import { Line } from './line-score-data-display/line'
import { LineScoreGrid } from './line-score-data-display/line-score-grid'

export interface LineScoreDataDisplayProps {
  lineScoreData: LineScoreData
}

export const LineScoreDataDisplay = ({ lineScoreData }: LineScoreDataDisplayProps) => {
  const { bestOf, sides, games } = lineScoreData
  return (
    <LineScoreGrid bestOf={bestOf}>
      {sides.map((side, i) => (
        <Line key={i} bestOf={bestOf} sides={sides} games={games} side={side} />
      ))}
    </LineScoreGrid>
  )
}
