import type { DashboardRecentResult } from '@/api/dashboard'
import { UserAvatar } from '@/components/ui/user-avatar'
import { Overline } from '@/components/overline'
import { fmtDateShort } from '@/lib/dates'
import { formatRatingDelta, formatRatingDeltaAria } from '@/lib/rating'
import { C, UI } from '@/components/dashboard/dashboard-tokens'

import { Card } from './card'
import { Mono } from './mono'

// Used everywhere an opponent slot has no registered player — the form's
// solo-match path produces this. Matches the label used on the match-details
// hero and form-history rows so the same match reads identically wherever it
// surfaces.
const NO_OPPONENT_LABEL = 'No opponent'

export interface RecentResultsCardProps {
  rows: DashboardRecentResult[]
}

export const RecentResultsCard = ({ rows }: RecentResultsCardProps) => {
  const wins = rows.filter((r) => r.is_win).length
  return (
    <Card padding={0} style={{ minWidth: 0 }}>
      <div
        data-testid="dashboard-recent-results"
        style={{
          padding: '14px 18px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: `1px solid ${C.ink700}`,
        }}
      >
        <Overline id="dashboard-recent-results-label">Recent matches</Overline>
        <div style={{ flex: 1 }} />
        <span style={{ font: `500 11px ${UI}`, color: C.chalk500 }}>
          <Mono size={11} color={C.chalk100}>
            {wins}-{rows.length - wins}
          </Mono>{' '}
          · last {rows.length}
        </span>
      </div>
      {rows.length === 0 ? (
        <div
          style={{
            padding: '20px 18px',
            font: `400 13px ${UI}`,
            color: C.chalk300,
          }}
        >
          No completed matches yet.
        </div>
      ) : (
        <table
          aria-labelledby="dashboard-recent-results-label"
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            font: `400 13px ${UI}`,
            color: C.chalk100,
          }}
        >
          <thead>
            <tr
              style={{
                font: `600 10px ${UI}`,
                color: C.chalk500,
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
              <th
                aria-label="Rating change"
                style={{ textAlign: 'right', padding: '10px 8px 8px', fontWeight: 600 }}
              >
                Δ
              </th>
              <th style={{ textAlign: 'right', padding: '10px 18px 8px', fontWeight: 600 }}>
                When
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const opponent = r.opponent_username
              const opponentLabel = opponent ?? NO_OPPONENT_LABEL
              const score = `${r.my_games_won}-${r.opponent_games_won}`
              return (
                <tr
                  key={r.match_id}
                  style={{ borderTop: i === 0 ? 'none' : `1px solid ${C.ink700}` }}
                >
                  {/* maxWidth:0 + width:100% is what actually caps this cell:
                      in an auto-layout table the opponent column otherwise
                      claims min-content width and pushes the trailing columns
                      past the card, so text-overflow:ellipsis never engages
                      until the cell is forced to collapse to the table width. */}
                  <td style={{ padding: '11px 18px', maxWidth: 0, width: '100%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          flexShrink: 0,
                          background: r.is_win ? C.serve500 : C.loss,
                          boxShadow: `0 0 6px ${r.is_win ? 'rgba(0,226,154,0.5)' : 'rgba(255,77,109,0.5)'}`,
                        }}
                      />
                      <UserAvatar name={opponent} size={24} />
                      <span
                        title={opponentLabel}
                        style={{
                          color: opponent ? C.chalk50 : C.chalk500,
                          fontStyle: opponent ? 'normal' : 'italic',
                          fontWeight: 500,
                          whiteSpace: 'nowrap',
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {opponentLabel}
                      </span>
                    </div>
                  </td>
                  <td style={{ padding: '11px 8px', textAlign: 'right' }}>
                    <Mono size={13} weight={500} color={r.is_win ? C.serve500 : C.loss}>
                      {score}
                    </Mono>
                  </td>
                  <td style={{ padding: '11px 8px', textAlign: 'right' }}>
                    {r.my_rating_change ? (
                      <Mono
                        size={12}
                        weight={500}
                        ariaLabel={formatRatingDeltaAria(r.my_rating_change.delta)}
                        color={
                          r.my_rating_change.delta >= 0
                            ? C.serve500
                            : C.loss
                        }
                      >
                        {formatRatingDelta(r.my_rating_change.delta)}
                      </Mono>
                    ) : (
                      <Mono size={12} color={C.chalk500}>
                        —
                      </Mono>
                    )}
                  </td>
                  <td style={{ padding: '11px 18px', textAlign: 'right' }}>
                    <Mono size={11} color={C.chalk500}>
                      {fmtDateShort(r.completed_at)}
                    </Mono>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}
