import { C } from '@/components/dashboard/dashboard-tokens'

import { Shimmer } from '../shimmer'
import { Card } from './card'

// Three placeholder result rows — a representative slice of the last-N table.
// Row count only affects this card's height; nothing below it depends on the
// exact number, so a small fixed count keeps the reserved box stable.
const ROWS = 3

/**
 * Loading placeholder for the {@link RecentResultsCard}, shown by `YourGameRow`
 * while the dashboard query resolves. Reuses the real card's `Card` chrome and
 * header strip, then renders the SAME `<table>` structure the loaded card does
 * (a shimmered `<thead>` band + N `<tbody>` rows) so every column width is
 * *derived* from the shared table layout rather than eyeballed. In particular
 * the opponent cell keeps the loaded card's `maxWidth:0; width:100%` collapse
 * and its inner `dot → avatar → name` flex, so the name bar doesn't snap width
 * the moment real rows mount (#863).
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
      <table
        data-testid="dashboard-recent-results-skeleton"
        style={{ width: '100%', borderCollapse: 'collapse' }}
      >
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '10px 18px 8px' }}>
              <Shimmer width={62} height={8} style={{ display: 'inline-block' }} />
            </th>
            <th style={{ textAlign: 'right', padding: '10px 8px 8px' }}>
              <Shimmer width={34} height={8} style={{ display: 'inline-block' }} />
            </th>
            <th style={{ textAlign: 'right', padding: '10px 8px 8px' }}>
              <Shimmer width={10} height={8} style={{ display: 'inline-block' }} />
            </th>
            <th style={{ textAlign: 'right', padding: '10px 18px 8px' }}>
              <Shimmer width={30} height={8} style={{ display: 'inline-block' }} />
            </th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: ROWS }, (_, i) => (
            <tr
              key={i}
              data-testid="dashboard-recent-results-skeleton-row"
              style={{ borderTop: i === 0 ? 'none' : `1px solid ${C.ink700}` }}
            >
              {/* Mirror the loaded card's collapsing opponent cell:
                  maxWidth:0 + width:100% forces the column to the table width
                  so the name shimmer's width is *derived* here rather than
                  hand-set — the fix for the name bar snapping on load (#863). */}
              <td
                data-testid="dashboard-recent-results-skeleton-opponent"
                style={{ padding: '11px 18px', maxWidth: 0, width: '100%' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span
                    data-testid="dashboard-recent-results-skeleton-dot"
                    style={{ display: 'flex', flexShrink: 0 }}
                  >
                    <Shimmer width={6} height={6} radius={3} />
                  </span>
                  <Shimmer width={24} height={24} radius={12} style={{ flexShrink: 0 }} />
                  <Shimmer height={14} style={{ flex: 1, minWidth: 0 }} />
                </div>
              </td>
              <td style={{ padding: '11px 8px', textAlign: 'right' }}>
                <Shimmer width={36} height={13} style={{ display: 'inline-block' }} />
              </td>
              <td style={{ padding: '11px 8px', textAlign: 'right' }}>
                <Shimmer width={28} height={12} style={{ display: 'inline-block' }} />
              </td>
              <td style={{ padding: '11px 18px', textAlign: 'right' }}>
                <Shimmer width={44} height={11} style={{ display: 'inline-block' }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Card>
)
