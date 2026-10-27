// Example data for /login-gate2. Nothing here comes from the API.

export type Gate2Match = {
  opponent: string
  won: boolean
  score: string
  date: string
  time: string
}

// One open "Is this you?" question: a player that a sign-in brought to the
// account.
export type Gate2Question = {
  player: string
  // Every match the player played, and up to 3 of them, newest first.
  total: number
  matches: readonly Gate2Match[]
  // The name the player keeps after Yes. Yes merges the player into the
  // account's self player, and the player created first survives. So this
  // is `player` when the question's player is older, as after a first
  // sign-in, and the account's player otherwise. The real gate reads it from
  // the server for each question.
  survivor: string
}

export const firstSignIn: Gate2Question = {
  player: 'mellow mongoose 594',
  total: 3,
  matches: [
    { opponent: 'Sam Ortiz', won: true, score: '3–1', date: 'Tue 27 Oct', time: '19:40' },
    { opponent: 'Priya Nair', won: false, score: '1–3', date: 'Tue 27 Oct', time: '19:05' },
    { opponent: 'Jonas Berg', won: true, score: '3–0', date: 'Tue 27 Oct', time: '18:30' },
  ],
  survivor: 'mellow mongoose 594',
}

export const existingAccount: Gate2Question = { ...firstSignIn, survivor: 'excited egret 387' }

// An older question from another device. It shows 3 of its 5 matches.
export const olderQuestion: Gate2Question = {
  player: 'brave badger 214',
  total: 5,
  matches: [
    { opponent: 'Lin Wei', won: false, score: '2–3', date: 'Mon 19 Oct', time: '20:15' },
    { opponent: 'Ama Okafor', won: true, score: '3–2', date: 'Mon 19 Oct', time: '19:30' },
    { opponent: 'Jonas Berg', won: true, score: '3–1', date: 'Sat 17 Oct', time: '11:40' },
  ],
  survivor: 'excited egret 387',
}

export const longNames: Gate2Question = {
  player: 'harmonious hummingbird 908',
  total: 12,
  matches: [
    { opponent: 'Oluwaseun Adeyemi-Fitzgerald', won: true, score: '3–2', date: 'Sun 25 Oct', time: '16:05' },
    { opponent: 'Maximiliane Hohenberger', won: false, score: '0–3', date: 'Sun 25 Oct', time: '15:20' },
    { opponent: 'Priya Nair', won: true, score: '3–1', date: 'Sat 24 Oct', time: '10:10' },
  ],
  survivor: 'knightly kingfisher 641',
}

// Whether Yes keeps the question's own player, so its matches are saved
// under its name.
export function keepsOwnName(question: Gate2Question): boolean {
  return question.survivor === question.player
}

export function matchCount(total: number): string {
  return total === 1 ? '1 match' : `${total} matches`
}

// The sentence above the answers: what Yes does.
export function outcome(question: Gate2Question): string {
  const these = question.total === 1 ? 'This match' : `These ${question.total} matches`
  return keepsOwnName(question)
    ? `${these} will be saved to your account under ${question.player}.`
    : `${these} will be added to ${question.survivor}.`
}

export function yesLabel(question: Gate2Question): string {
  return keepsOwnName(question) ? 'Yes, save my matches' : 'Yes, add to my player'
}

// The confirmation after each answer, in the gate and in the dashboard's
// toast.
export function yesConfirmation(question: Gate2Question): string {
  return keepsOwnName(question)
    ? `${matchCount(question.total)} saved under ${question.player}.`
    : `${matchCount(question.total)} added to ${question.survivor}.`
}

export function manageConfirmation(question: Gate2Question): string {
  return `You manage ${question.player} now.`
}

export function removeConfirmation(question: Gate2Question): string {
  return `${question.player} removed from your account.`
}
