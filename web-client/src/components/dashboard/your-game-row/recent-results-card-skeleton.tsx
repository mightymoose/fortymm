import { C } from '@/components/dashboard/dashboard-tokens'

import { Shimmer } from '../shimmer'
import { Card } from './card'

// Three placeholder result rows — a representative slice of the last-N table.
// Row count only affects this card's height; nothing below it depends on the
// exact number, so a small fixed count keeps the reserved box stable.
const ROWS = 3

/**
 * Loading placeholder for the {@link RecentResultsCard}, shown by `YourGameRow`
 * while the dashboard query resolves. Reuses the real card's `Card` chrome,
 * header strip, and four-column row layout (opponent · score · Δ · when) so the
 * card occupies the same box the loaded table will — only the leaf text/avatars
 * become shimmer bars. Mirrors `RecentResultsCard`'s markup by hand (the real
 * tree isn't mounted during load), so revisit it if that structure changes.
 */
export const RecentResultsCardSkeleton = () => (
  <Card
    padding={0}
    role="status"
    aria-busy="true"
    aria-label="Loading recent matches"
    style={{ minWidth: 0 }}
  >
    <div aria-hidden="true">
      <div
        style={{
          padding: '14px 18px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: `1px solid ${C.ink700}`,
        }}
      >
        <Shimmer width={110} height={10} />
        <div style={{ flex: 1 }} />
        <Shimmer width={70} height={11} />
      </div>
      {Array.from({ length: ROWS }, (_, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minWidth: 0,
            padding: '11px 18px',
            borderTop: i === 0 ? 'none' : `1px solid ${C.ink700}`,
          }}
        >
          <Shimmer width={24} height={24} radius={12} />
          <Shimmer height={14} style={{ flex: 1, minWidth: 0, maxWidth: 140 }} />
          <Shimmer width={36} height={13} />
          <Shimmer width={28} height={12} />
          <Shimmer width={44} height={11} />
        </div>
      ))}
    </div>
  </Card>
)
