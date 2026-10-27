// Example data for the login gate mockups. Nothing here comes from the API.

export type GuestMatch = {
  opponent: string
  won: boolean
  score: string
  time: string
}

export const guestPlayer = 'mellow mongoose 594'

// Newest first.
export const guestMatches: readonly GuestMatch[] = [
  { opponent: 'Sam Ortiz', won: true, score: '3–1', time: '19:40' },
  { opponent: 'Priya Nair', won: false, score: '1–3', time: '19:05' },
  { opponent: 'Jonas Berg', won: true, score: '3–0', time: '18:30' },
]

export const guestActivity = '3 matches today. Last one against Sam Ortiz, won 3–1.'

// The existing account's player, for a sign-in to an existing account.
export const accountPlayer = 'excited egret 387'
export const accountActivity = '128 matches since March'
export const mergedActivity = '131 matches'

// A first sign-in makes a new account. A sign-in to an existing account
// finds one that already has a player.
export type AccountCase = 'new' | 'existing'

export type SaveStatus = 'idle' | 'saving' | 'error'

// One frame of the question, before the dashboard.
export type QuestionFrame = { step: 1 | 2; account: AccountCase; status: SaveStatus }

// The answer whose toast the dashboard shows.
export type ToastAnswer = 'yes-new' | 'yes-existing' | 'manage' | 'remove'

export type Frame = { title: string } & (
  | { kind: 'question'; question: QuestionFrame }
  | { kind: 'toast'; answer: ToastAnswer }
)

export const frames: readonly Frame[] = [
  { title: 'Step 1, first sign-in', kind: 'question', question: { step: 1, account: 'new', status: 'idle' } },
  {
    title: 'Step 1, sign-in to an existing account',
    kind: 'question',
    question: { step: 1, account: 'existing', status: 'idle' },
  },
  { title: 'Step 2', kind: 'question', question: { step: 2, account: 'existing', status: 'idle' } },
  { title: 'Saving', kind: 'question', question: { step: 1, account: 'existing', status: 'saving' } },
  { title: 'Error', kind: 'question', question: { step: 1, account: 'existing', status: 'error' } },
  { title: 'Toast after Yes, first sign-in', kind: 'toast', answer: 'yes-new' },
  { title: 'Toast after Yes, existing account', kind: 'toast', answer: 'yes-existing' },
  { title: 'Toast after I manage this player', kind: 'toast', answer: 'manage' },
  { title: 'Toast after Remove from my account', kind: 'toast', answer: 'remove' },
]
