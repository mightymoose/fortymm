import { Card as UICard } from '@/components/ui/card'
import { UserAvatar } from '@/components/ui/user-avatar'
import { Overline } from '@/components/overline'

import { Mono } from './mono'
import type {
  RecentResultRowView,
  RecentResultsCardView,
} from './recent-results-card/recent-results-card-view'

export interface RecentResultsCardProps {
  view: RecentResultsCardView
}

const UI = 'var(--font-ui)'

/**
 * The dashboard's "Recent matches" card: a win-loss record line above a table
 * of the viewer's latest completed matches (opponent, score, rating delta,
 * date), or a calm empty state when there are none. Pure view-in — all
 * tallying and per-row formatting are decided by `projectRecentResultsCardView`.
 */
export const RecentResultsCard = ({ view }: RecentResultsCardProps) => {
  const { record, count, rows } = view
  return (
    <UICard className="relative block min-w-0 p-0">
      <div
        data-testid="dashboard-recent-results"
        style={{
          padding: '14px 18px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: '1px solid var(--ink-700)',
        }}
      >
        <Overline>Recent matches</Overline>
        <div style={{ flex: 1 }} />
        <span style={{ font: `500 11px ${UI}`, color: 'var(--chalk-500)' }}>
          <Mono size={11} color="var(--chalk-100)">
            {record}
          </Mono>{' '}
          · last {count}
        </span>
      </div>
      {rows.length === 0 ? (
        <div
          style={{
            padding: '20px 18px',
            font: `400 13px ${UI}`,
            color: 'var(--chalk-300)',
          }}
        >
          No completed matches yet.
        </div>
      ) : (
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            font: `400 13px ${UI}`,
            color: 'var(--chalk-100)',
          }}
        >
          <thead>
            <tr
              style={{
                font: `600 10px ${UI}`,
                color: 'var(--chalk-500)',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
              }}
            >
              <th style={{ textAlign: 'left', padding: '10px 18px 8px', fontWeight: 600 }}>
                Opponent
              </th>
              <th style={{ textAlign: 'right', padding: '10px 8px 8px', fontWeight: 600 }}>
                Score
              </th>
              <th style={{ textAlign: 'right', padding: '10px 8px 8px', fontWeight: 600 }}>
                Δ
              </th>
              <th style={{ textAlign: 'right', padding: '10px 18px 8px', fontWeight: 600 }}>
                When
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <RecentResultRow key={row.matchId} row={row} first={i === 0} />
            ))}
          </tbody>
        </table>
      )}
    </UICard>
  )
}

function RecentResultRow({
  row,
  first,
}: {
  row: RecentResultRowView
  first: boolean
}) {
  const winColor = row.isWin ? 'var(--serve-500)' : 'var(--loss)'
  return (
    <tr style={{ borderTop: first ? 'none' : '1px solid var(--ink-700)' }}>
      <td style={{ padding: '11px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: winColor,
              boxShadow: `0 0 6px ${row.isWin ? 'rgba(0,226,154,0.5)' : 'rgba(255,77,109,0.5)'}`,
            }}
          />
          <UserAvatar name={row.opponentName} size={24} />
          <span
            style={{
              color: row.opponentName ? 'var(--chalk-50)' : 'var(--chalk-500)',
              fontStyle: row.opponentName ? 'normal' : 'italic',
              fontWeight: 500,
              whiteSpace: 'nowrap',
            }}
          >
            {row.opponentLabel}
          </span>
        </div>
      </td>
      <td style={{ padding: '11px 8px', textAlign: 'right' }}>
        <Mono size={13} weight={500} color={winColor}>
          {row.score}
        </Mono>
      </td>
      <td style={{ padding: '11px 8px', textAlign: 'right' }}>
        {row.delta !== null ? (
          <Mono
            size={12}
            weight={500}
            color={
              row.delta.startsWith('-') ? 'var(--loss)' : 'var(--serve-500)'
            }
          >
            {row.delta}
          </Mono>
        ) : (
          <Mono size={12} color="var(--chalk-500)">
            —
          </Mono>
        )}
      </td>
      <td style={{ padding: '11px 18px', textAlign: 'right' }}>
        <Mono size={11} color="var(--chalk-500)">
          {row.when}
        </Mono>
      </td>
    </tr>
  )
}
