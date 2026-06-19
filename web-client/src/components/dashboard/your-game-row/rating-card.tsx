import type { DashboardRating } from '@/api/dashboard'
import { Overline } from '@/components/overline'
import { formatRatingDelta } from '@/lib/rating'
import { C, MONO, UI } from '@/components/dashboard/dashboard-tokens'

import { Card } from './card'
import { Mono } from './mono'
import { Pill } from './rating-card/pill'
import { Sparkline } from './rating-card/sparkline'
import { Stat } from './rating-card/stat'

export interface RatingCardProps {
  rating: DashboardRating
}

export const RatingCard = ({ rating }: RatingCardProps) => {
  const { current, delta, peak, percentile, spark_data, streak, stats } = rating
  // Sparkline needs ≥2 points to draw a line; pad a single point so the
  // freshly-rated case still shows a level baseline.
  const sparkPoints =
    spark_data.length >= 2
      ? spark_data
      : [spark_data[0] ?? current, spark_data[0] ?? current]
  // Peak tile + whatever strategy-specific stats the API returned; capped at
  // three because the grid is 3 columns.
  const tiles = [
    { label: 'Peak', value: String(Math.round(peak)) },
    ...stats,
  ].slice(0, 3)
  return (
    <Card
      padding={20}
      // minWidth:0 lets the card shrink to its grid track instead of forcing the
      // track wider than its `fr` share (grid items default to min-width:auto).
      style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Overline>Current rating</Overline>
        <div style={{ flex: 1 }} />
        {streak ? (
          <Pill tone={streak.kind === 'W' ? 'win' : 'loss'} mono>
            {streak.kind}
            {streak.n}
          </Pill>
        ) : null}
      </div>
      {/* flexWrap so the delta/percentile column drops below the big number
          rather than overflowing (and being clipped) in a narrow card. */}
      <div
        style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', rowGap: 8 }}
      >
        <Mono size={56} weight={700} color={C.chalk50} style={{ lineHeight: 0.9 }}>
          {Math.round(current)}
        </Mono>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <Pill tone={delta >= 0 ? 'win' : 'loss'} mono>
            {formatRatingDelta(delta)} last match
          </Pill>
          {percentile !== null ? (
            <span style={{ font: `400 11px ${UI}`, color: C.chalk500 }}>
              Top{' '}
              <Mono size={11} color={C.chalk300}>
                {percentile}%
              </Mono>{' '}
              in {rating.league_name}
            </span>
          ) : (
            <span style={{ font: `400 11px ${UI}`, color: C.chalk500 }}>
              {rating.league_name}
            </span>
          )}
        </div>
      </div>
      <div
        style={{
          padding: '10px 12px',
          background: C.ink900,
          borderRadius: 8,
          border: `1px solid ${C.ink700}`,
        }}
      >
        <Sparkline data={sparkPoints} w={280} h={48} fluid />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 6,
            font: `400 10px ${MONO}`,
            color: C.chalk500,
            letterSpacing: '0.08em',
          }}
        >
          <span>30 days ago</span>
          <span>Today · peak {Math.round(peak)}</span>
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
    </Card>
  )
}
