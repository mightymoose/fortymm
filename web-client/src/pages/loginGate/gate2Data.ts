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
  // Every match the player played, and the dates of the first and the last.
  total: number
  range: string
  // The newest matches first. The gate shows 3. "View all" pages through the
  // rest.
  matches: readonly Gate2Match[]
  // The account's own player, by the name the person knows. A first sign-in
  // has none: its account's player is new, and nobody saw its name.
  accountPlayer?: string
  // The name after Yes. Yes merges the two players, and the one created
  // first survives. The other gets `merged_into` set to it. No match moves.
  // So this is `player` when the question's player is the older one. The
  // real gate reads it from the server for each question.
  survivor: string
}

// The number of matches the gate shows before "View all".
export const SHOWN = 3

// The number of matches "View all" loads at a time.
export const PAGE = 20

export const firstSignIn: Gate2Question = {
  player: 'mellow mongoose 594',
  total: 3,
  range: 'Oct 27',
  matches: [
    { opponent: 'Sam Ortiz', won: true, score: '3–1', date: 'Tue, Oct 27', time: '19:40' },
    { opponent: 'Priya Nair', won: false, score: '1–3', date: 'Tue, Oct 27', time: '19:05' },
    { opponent: 'Jonas Berg', won: true, score: '3–0', date: 'Tue, Oct 27', time: '18:30' },
  ],
  survivor: 'mellow mongoose 594',
}

export const existingAccount: Gate2Question = {
  ...firstSignIn,
  accountPlayer: 'excited egret 387',
  survivor: 'excited egret 387',
}

// The guest player is older than the account's player, so its name
// survives.
export const olderGuest: Gate2Question = {
  player: 'hardy heron 233',
  total: 2,
  range: 'Aug 30',
  matches: [
    { opponent: 'Lin Wei', won: true, score: '3–2', date: 'Sun, Aug 30', time: '15:10' },
    { opponent: 'Ama Okafor', won: false, score: '1–3', date: 'Sun, Aug 30', time: '14:25' },
  ],
  accountPlayer: 'excited egret 387',
  survivor: 'hardy heron 233',
}

const opponents = ['Lin Wei', 'Ama Okafor', 'Jonas Berg', 'Priya Nair', 'Sam Ortiz', 'Mei Tanaka', 'Tomás Reyes']
const wins = ['3–1', '3–0', '3–2']
const losses = ['1–3', '2–3', '0–3']
const times = ['19:40', '18:55', '20:10']

// `count` matches, newest first, from `last` back about one a day.
function history(count: number, last: Date): Gate2Match[] {
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(last)
    day.setUTCDate(last.getUTCDate() - Math.floor(index * 1.15))
    const won = index % 3 !== 1
    return {
      opponent: opponents[index % opponents.length],
      won,
      score: won ? wins[index % 3] : losses[index % 3],
      date: day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
      time: times[index % 3],
    }
  })
}

// An older question from another device, with a few more matches than the
// gate shows.
export const olderQuestion: Gate2Question = {
  player: 'brave badger 214',
  total: 12,
  range: 'Oct 15–27',
  matches: history(12, new Date(Date.UTC(2026, 9, 27))),
  accountPlayer: 'excited egret 387',
  survivor: 'excited egret 387',
}

export const largeHistory: Gate2Question = {
  player: 'kindly koala 552',
  total: 48,
  range: 'Sep 3–Oct 27',
  matches: history(48, new Date(Date.UTC(2026, 9, 27))),
  accountPlayer: 'excited egret 387',
  survivor: 'excited egret 387',
}

export const longNames: Gate2Question = {
  player: 'harmonious hummingbird 908',
  total: 12,
  range: 'Oct 17–25',
  matches: [
    { opponent: 'Oluwaseun Adeyemi-Fitzgerald', won: true, score: '3–2', date: 'Sun, Oct 25', time: '16:05' },
    { opponent: 'Maximiliane Hohenberger', won: false, score: '0–3', date: 'Sun, Oct 25', time: '15:20' },
    { opponent: 'Priya Nair', won: true, score: '3–1', date: 'Sat, Oct 24', time: '10:10' },
  ],
  accountPlayer: 'knightly kingfisher 641',
  survivor: 'knightly kingfisher 641',
}

export function matchCount(total: number): string {
  return total === 1 ? '1 match' : `${total} matches`
}

// "All 12 matches" when the gate shows only some of them.
function scope(question: Gate2Question): string {
  if (question.total === 1) return 'This match'
  return question.total > SHOWN ? `All ${question.total} matches` : `These ${question.total} matches`
}

// The sentence above the answers: what Yes does.
export function outcome(question: Gate2Question): string {
  const { player, accountPlayer, survivor } = question
  if (!accountPlayer) return `${scope(question)} will be saved to your account under ${player}.`
  if (survivor === accountPlayer) return `${scope(question)} will be added to ${accountPlayer}.`
  return `${scope(question)} will be added to your player. Its name changes from ${accountPlayer} to ${survivor}, because ${survivor} is the older player.`
}

export function yesLabel(question: Gate2Question): string {
  return question.accountPlayer ? 'Yes, add to my player' : 'Yes, save my matches'
}

// The account's player after Yes, for the topbar's chip.
export function playerAfterYes(question: Gate2Question): string {
  return question.survivor
}

// The account's player after the other answers.
export function playerAfterNo(question: Gate2Question): string {
  return question.accountPlayer ?? question.survivor
}

// The confirmation after each answer, in the gate and in the dashboard's
// toast.
export function yesConfirmation(question: Gate2Question): string {
  const { player, accountPlayer, survivor, total } = question
  if (!accountPlayer) return `${matchCount(total)} saved under ${player}.`
  if (survivor === accountPlayer) return `${matchCount(total)} added to ${accountPlayer}.`
  return `${matchCount(total)} added. Your player is ${survivor} now.`
}

export function manageConfirmation(question: Gate2Question): string {
  return `You manage ${question.player} now.`
}

export function removeConfirmation(question: Gate2Question): string {
  return `${question.player} removed from your account.`
}
