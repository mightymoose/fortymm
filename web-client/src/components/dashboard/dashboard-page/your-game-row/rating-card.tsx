import { Badge } from '@/components/ui/badge'
import { Card as UICard } from '@/components/ui/card'
import { Overline } from '@/components/overline'
import { cn } from '@/lib/utils'

import { Mono } from './mono'
import { Sparkline } from './rating-card/sparkline'
import { Stat } from './rating-card/stat'
import type { RatingCardView } from './rating-card/rating-card-view'

export interface RatingCardProps {
  view: RatingCardView
}

const UI = 'var(--font-ui)'
const MONO = 'var(--font-mono)'

// Tinted mono badge for the streak and delta chips — green for a win/positive
// delta, red otherwise. Replaces the legacy bespoke `Pill` with the
// design-system `Badge`.
function toneClass(isWin: boolean): string {
  return isWin
    ? 'bg-[color:var(--serve-500)]/12 text-[color:var(--serve-500)]'
    : 'bg-[color:var(--loss)]/12 text-[color:var(--loss)]'
}

/**
 * The dashboard's "Current rating" card: the hero numeral with its delta and
 * streak badges, a 30-day sparkline, and up to three stat tiles. Pure view-in —
 * all rounding, formatting, padding, and tile selection are decided by
 * `projectRatingCardView`.
 */
export const RatingCard = ({ view }: RatingCardProps) => {
  const {
    current,
    delta,
    deltaIsPositive,
    percentile,
    leagueName,
    peak,
    streak,
    sparkPoints,
    tiles,
  } = view
  return (
    // minWidth:0 lets the card shrink to its grid track instead of forcing the
    // track wider than its `fr` share (grid items default to min-width:auto).
    <UICard
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        minWidth: 0,
        padding: 20,
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Overline>Current rating</Overline>
        <div style={{ flex: 1 }} />
        {streak ? (
          <Badge
            className={cn(
              'font-mono tabular-nums tracking-[0.04em]',
              toneClass(streak.isWin),
            )}
          >
            {streak.label}
          </Badge>
        ) : null}
      </div>
      {/* flexWrap so the delta/percentile column drops below the big number
          rather than overflowing (and being clipped) in a narrow card. */}
      <div
        style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', rowGap: 8 }}
      >
        <Mono size={56} weight={700} color="var(--chalk-50)" style={{ lineHeight: 0.9 }}>
          {current}
        </Mono>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <Badge
            className={cn(
              'font-mono tabular-nums tracking-[0.04em]',
              toneClass(deltaIsPositive),
            )}
          >
            {delta} last match
          </Badge>
          {percentile !== null ? (
            <span style={{ font: `400 11px ${UI}`, color: 'var(--chalk-500)' }}>
              Top{' '}
              <Mono size={11} color="var(--chalk-300)">
                {percentile}%
              </Mono>{' '}
              in {leagueName}
            </span>
          ) : (
            <span style={{ font: `400 11px ${UI}`, color: 'var(--chalk-500)' }}>
              {leagueName}
            </span>
          )}
        </div>
      </div>
      <div
        style={{
          padding: '10px 12px',
          background: 'var(--ink-900)',
          borderRadius: 8,
          border: '1px solid var(--ink-700)',
        }}
      >
        <Sparkline data={sparkPoints} w={280} h={48} fluid />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 6,
            font: `400 10px ${MONO}`,
            color: 'var(--chalk-500)',
            letterSpacing: '0.08em',
          }}
        >
          <span>30 days ago</span>
          <span>Today · peak {peak}</span>
        </div>
      </div>
      {/* auto-fit so the tiles reflow to 2 (or 1) columns when the card is too
          narrow for three, instead of overflowing the fixed 3-up grid. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))',
          gap: 8,
        }}
      >
        {tiles.map((tile) => (
          <Stat key={tile.label} label={tile.label} value={tile.value} />
        ))}
      </div>
    </UICard>
  )
}
