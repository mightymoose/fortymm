import { Card } from '@/components/dashboard/your-game-row/card'
import { C, UI } from '@/components/dashboard/dashboard-tokens'
import { Overline } from '@/components/overline'

/** The zero-match dashboard's replacement for the recent-matches card — a
 * friendlier empty state than the terse placeholder shown once a rated
 * league exists but nothing's been played there yet.
 *
 * The words carry the state on their own, so the card holds no illustration:
 * a decorative table glyph sat here and read as clutter rather than meaning. */
export const NoMatchesCard = () => {
  return (
    <Card style={{ minWidth: 0 }}>
      <Overline>Recent matches</Overline>
      <div style={{ marginTop: 10, font: `600 14px ${UI}`, color: C.chalk100 }}>
        No matches yet. Go play.
      </div>
      <div style={{ marginTop: 6, font: `400 13px ${UI}`, color: C.chalk300 }}>
        Your completed matches will show up here.
      </div>
    </Card>
  )
}
