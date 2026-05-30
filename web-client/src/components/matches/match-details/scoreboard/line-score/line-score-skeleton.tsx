import { LineScoreGrid } from './line-score-data/line-score-data-display/line-score-grid'
import { LineSkeleton } from './line-score-data/line-score-data-display/line-skeleton'

// Loading placeholder for <LineScoreData />. Mirrors the `LineScoreDataDisplay`
// layout — the md-games grid with one row per side — composed from the per-row
// skeleton beside its component. The real game count is unknown while the data
// is in flight, so it shows three placeholder columns (and no G1/G2/… labels,
// which we can't know are correct yet) and the common two-sides shape.
const SKELETON_GAME_COLUMNS = 3

export const LineScoreSkeleton = () => (
  <LineScoreGrid bestOf={SKELETON_GAME_COLUMNS} showGameLabels={false}>
    <LineSkeleton bestOf={SKELETON_GAME_COLUMNS} />
    <LineSkeleton bestOf={SKELETON_GAME_COLUMNS} />
  </LineScoreGrid>
)
