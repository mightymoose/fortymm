import { C } from '@/components/dashboard/dashboard-tokens'

import { Shimmer } from '../shimmer'
import { Card } from './card'

// The loaded card always renders three stat tiles (Peak + up to two strategy
// stats), reflowing to fewer columns when narrow. Reserve three.
const TILES = 3

const panelStyle = {
  padding: '10px 12px',
  background: C.ink900,
  borderRadius: 8,
  border: `1px solid ${C.ink700}`,
} as const

/**
 * Loading placeholder for the {@link RatingCard}, shown by `YourGameRow` while
 * the dashboard query resolves. Reuses the real card's `Card` chrome and the
 * inset sparkline / stat-tile panels so the card occupies the same box the
 * loaded card will — only the overline, big rating number, delta, sparkline,
 * and stat values become shimmer bars. Mirrors `RatingCard`'s markup by hand
 * (the real tree isn't mounted during load), so revisit it if that structure
 * changes.
 */
export const RatingCardSkeleton = () => (
  <Card
    padding={20}
    role="status"
    aria-busy="true"
    aria-label="Loading rating"
    style={{ minWidth: 0 }}
  >
    <div
      aria-hidden="true"
      style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
    >
      <Shimmer width={92} height={10} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Shimmer width={116} height={52} radius={8} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Shimmer width={120} height={18} radius={9} />
          <Shimmer width={88} height={11} />
        </div>
      </div>
      <div style={panelStyle}>
        <Shimmer height={48} />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 6,
          }}
        >
          <Shimmer width={64} height={10} />
          <Shimmer width={96} height={10} />
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))',
          gap: 8,
        }}
      >
        {Array.from({ length: TILES }, (_, i) => (
          <div key={i} style={panelStyle}>
            <Shimmer width={36} height={9} />
            <Shimmer width={48} height={16} style={{ marginTop: 5 }} />
          </div>
        ))}
      </div>
    </div>
  </Card>
)
