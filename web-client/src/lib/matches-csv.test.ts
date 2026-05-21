import { describe, expect, it } from 'vitest'
import type { MatchListRow } from '@/api/matches'
import { matchesToCsv } from './matches-csv'

function row(over: Partial<MatchListRow> = {}): MatchListRow {
  return {
    id: 'm-1',
    status: 'completed',
    status_label: 'Final',
    league: { id: 'l-1', name: 'FortyMM' },
    best_of: 5,
    created_at: '2026-05-20T10:00:00Z',
    current_game_id: null,
    can_score: false,
    sides: [
      {
        side_number: 1,
        players: [
          { user_id: 'u1', username: 'rita.kovac', is_current_user: true },
        ],
        games_won: 3,
        won: true,
        is_current_user_side: true,
      },
      {
        side_number: 2,
        players: [
          { user_id: 'u2', username: 'nguyen.t', is_current_user: false },
        ],
        games_won: 1,
        won: false,
        is_current_user_side: false,
      },
    ],
    ...over,
  } as MatchListRow
}

describe('matchesToCsv', () => {
  it('emits a header and one row per match with the expected columns', () => {
    const [header, line] = matchesToCsv([row()]).split('\r\n')
    expect(header).toBe(
      'Match ID,Created,Status,League,Side 1,Side 2,Score,Best of',
    )
    expect(line).toBe(
      'm-1,2026-05-20T10:00:00Z,Final,FortyMM,rita.kovac,nguyen.t,3-1,5',
    )
  })

  it('quotes fields containing a comma', () => {
    const line = matchesToCsv([
      row({ league: { id: 'l', name: 'Club, North' } }),
    ]).split('\r\n')[1]
    expect(line).toContain('"Club, North"')
  })

  it('blanks the score for non-played statuses', () => {
    const line = matchesToCsv([
      row({ status: 'pending', status_label: 'Scheduled' }),
    ]).split('\r\n')[1]
    // …,rita.kovac,nguyen.t,<blank score>,5
    expect(line.endsWith(',rita.kovac,nguyen.t,,5')).toBe(true)
  })

  it('blanks side 2 and score for a single-sided match', () => {
    const solo = row({ sides: [row().sides[0]] })
    const line = matchesToCsv([solo]).split('\r\n')[1]
    expect(line).toBe('m-1,2026-05-20T10:00:00Z,Final,FortyMM,rita.kovac,,,5')
  })
})
