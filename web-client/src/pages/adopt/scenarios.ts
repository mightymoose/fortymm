// Sample data for the adoption mockups (/adopt1 to /adopt3). Nothing here
// comes from the API.

export type Answer = 'yes' | 'no' | 'not-mine'

export type RecentMatch = { opponent: string; won: boolean; games: string; when: string }

// A player with `adopted_from` set: the account hasn't said who it is yet.
// `lastUsed` and `recentMatches` help a person recognise the player. Matches
// wait for games, so today a player has none.
export type Question = {
  playerId: string
  displayName: string
  lastUsed: string
  recentMatches: readonly RecentMatch[]
}

// What the page says about the sign-in that set up the questions. `adopted`
// moved players from a guest account, `verified` kept the guest account and
// gave it an email (verify in place), and `null` is a later visit to Home.
export type SignIn =
  | { kind: 'adopted'; email: string }
  | { kind: 'verified'; email: string }
  | null

export type Scenario = {
  label: string
  signIn: SignIn
  // The account's own player before any answer, or null if it has none.
  selfPlayer: string | null
  questions: readonly Question[]
}

const egret: Question = {
  playerId: 'p-egret',
  displayName: 'excited egret 387',
  lastUsed: 'today',
  recentMatches: [
    { opponent: 'Kofi Owusu', won: true, games: '3–1', when: 'Saturday' },
    { opponent: 'Lena Brandt', won: false, games: '1–3', when: '12 Oct' },
  ],
}
const badger: Question = {
  playerId: 'p-badger',
  displayName: 'brave badger 214',
  lastUsed: '3 days ago',
  recentMatches: [],
}

export const scenarios = {
  adopted: {
    label: 'Signed in to an account',
    signIn: { kind: 'adopted', email: 'ama@example.com' },
    selfPlayer: null,
    questions: [egret],
  },
  'has-player': {
    label: 'Account has its own player',
    signIn: { kind: 'adopted', email: 'ama@example.com' },
    selfPlayer: 'Ama Mensah',
    questions: [egret],
  },
  'new-email': {
    label: 'First sign-in, new email',
    signIn: { kind: 'verified', email: 'ama@example.com' },
    selfPlayer: null,
    questions: [egret],
  },
  two: {
    label: 'Two players moved',
    signIn: { kind: 'adopted', email: 'ama@example.com' },
    selfPlayer: null,
    questions: [egret, badger],
  },
  later: {
    label: 'Back on Home later',
    signIn: null,
    selfPlayer: null,
    questions: [egret, badger],
  },
} satisfies Record<string, Scenario>

export type ScenarioId = keyof typeof scenarios

export const scenarioIds = Object.keys(scenarios) as ScenarioId[]

export function validateAdoptSearch(search: Record<string, unknown>): { state: ScenarioId } {
  const state = search.state
  return {
    state: typeof state === 'string' && state in scenarios ? (state as ScenarioId) : 'adopted',
  }
}
