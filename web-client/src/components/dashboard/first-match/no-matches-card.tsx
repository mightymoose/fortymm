import { Card } from '@/components/dashboard/your-game-row/card'
import { C, UI } from '@/components/dashboard/dashboard-tokens'
import { Overline } from '@/components/overline'

/** Decorative table-tennis table glyph for the empty recent-matches card.
 * `aria-hidden` since the adjacent text already carries the meaning. */
function TableGlyph() {
  return (
    <svg
      width="56"
      height="40"
      viewBox="0 0 56 40"
      fill="none"
      aria-hidden
      style={{ color: C.ink500 }}
    >
      <rect x="2" y="6" width="22" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="32" y="6" width="22" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <line x1="27" y1="6" x2="27" y2="22" stroke="currentColor" strokeWidth="2" />
      <line x1="4" y1="28" x2="10" y2="36" stroke="currentColor" strokeWidth="2" />
      <line x1="52" y1="28" x2="46" y2="36" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

/** The zero-match dashboard's replacement for the recent-matches card — a
 * friendlier empty state than the terse placeholder shown once a rated
 * league exists but nothing's been played there yet. */
export const NoMatchesCard = () => {
  return (
    <Card style={{ minWidth: 0 }}>
      <Overline>Recent matches</Overline>
      <div
        style={{
          marginTop: 16,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 10,
          padding: '18px 8px 6px',
        }}
      >
        <TableGlyph />
        <div style={{ font: `600 14px ${UI}`, color: C.chalk100 }}>
          No matches yet. Go play.
        </div>
        <div style={{ font: `400 13px ${UI}`, color: C.chalk300 }}>
          Your completed matches will show up here.
        </div>
      </div>
    </Card>
  )
}
