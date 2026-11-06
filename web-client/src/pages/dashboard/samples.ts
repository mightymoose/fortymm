import type { AccountPlayer } from '../../api/queries'
import type { components } from '../../api/schema'
import type { RecentMatch } from './dashboard'
import type { Sample } from './search'

type Session = components['schemas']['SessionAccount']


export const sampleLabels: Record<Sample, string> = {
  busy: 'Regular player',
  new: 'New player',
  guest: 'Guest with matches',
}

// A Preview's database starts empty, so each option can also show made-up
// players to compare the filled states. Nothing here reaches the API.
export function sample(kind: Sample, account: Session, now: Date): { account: Session; players: AccountPlayer[] } {
  const ago = (days: number, hour: number, minute = 0) => {
    const at = new Date(now)
    at.setDate(now.getDate() - days)
    at.setHours(hour, minute, 0, 0)
    return at.toISOString()
  }
  const match = (id: string, playedAt: string, opponent: string, games: [number, number] | null): RecentMatch => ({
    id,
    played_at: playedAt,
    opponents: [opponent],
    ...(games ? { result: { won: games[0] > games[1], games } } : {}),
  })
  const self = (matches: RecentMatch[], count: number): AccountPlayer => ({
    id: account.player.id,
    display_name: account.player.display_name,
    relationship: 'self',
    open_question: false,
    match_count: count,
    recent_matches: matches,
    played_against: [],
  })
  const verified: Session = {
    ...account,
    kind: 'verified',
    email: account.email ?? 'you@example.com',
    permissions: [...new Set([...account.permissions, 'matches.create'])],
  }

  switch (kind) {
    case 'busy':
      return {
        account: verified,
        players: [
          self(
            [
              match('s1', ago(0, 19, 40), 'Park, Ji-ho', [3, 1]),
              match('s2', ago(0, 18, 55), 'Dubois, Camille', [3, 2]),
              match('s3', ago(1, 20, 10), 'Okafor, Tunde', [1, 3]),
              match('s4', ago(4, 19, 5), 'Brave badger 214', [3, 0]),
              match('s5', ago(11, 18, 30), 'Wójcik-Szymańska, Agnieszka', [2, 3]),
            ],
            14,
          ),
          {
            id: 'sample-mia',
            display_name: 'Mia (junior)',
            relationship: 'managed',
            open_question: false,
            match_count: 3,
            recent_matches: [
              match('m1', ago(2, 17, 0), 'Lee, Hana', [3, 1]),
              match('m2', ago(9, 17, 20), 'Novak, Petr', [0, 3]),
              match('m3', ago(9, 16, 40), 'Lee, Hana', null),
            ],
            played_against: [],
          },
        ],
      }
    case 'new':
      return { account: verified, players: [self([], 0)] }
    case 'guest':
      return {
        account: { ...account, kind: 'guest', email: null, permissions: [] },
        players: [
          self(
            [
              match('g1', ago(0, 11, 30), 'Dubois, Camille', [3, 1]),
              match('g2', ago(0, 10, 50), 'Park, Ji-ho', [2, 3]),
              match('g3', ago(0, 10, 5), 'Dubois, Camille', [3, 0]),
            ],
            3,
          ),
        ],
      }
  }
}
