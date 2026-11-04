import type { GamePoints } from './board'
import type { Fragment } from './fragment'

// What this tab knows about each match's board on the server. A board is a
// fragment's text: empty, a draft payload or an envelope. `pending` is the
// newest board this tab saved that the server hasn't taken yet, and
// `synced` the last one the server took from this tab or this tab pulled.
// Both stay in memory, because sync is best effort and the URL keeps the
// scores: a reload forgets an unsent board.
export type Boards = { pending: string | null; synced: string | null }

const NOTHING: Boards = { pending: null, synced: null }

const boards = new Map<string, Boards>()
const listeners = new Set<() => void>()

export function boardsOf(matchId: string): Boards {
  return boards.get(matchId) ?? NOTHING
}

function update(matchId: string, change: Partial<Boards>): void {
  boards.set(matchId, { ...boardsOf(matchId), ...change })
  for (const listener of listeners) listener()
}

export function subscribeBoards(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// A save. It replaces a board still waiting, which nobody needs any more.
export function saveBoard(matchId: string, text: string): void {
  if (boardsOf(matchId).pending !== text) update(matchId, { pending: text })
}

// The server took `text`. A board saved after it still waits.
export function acknowledge(matchId: string, text: string): void {
  const { pending } = boardsOf(matchId)
  update(matchId, { synced: text, pending: pending === text ? null : pending })
}

// The server refused `text` for good, so sending it again can't help.
export function dropBoard(matchId: string, text: string): void {
  if (boardsOf(matchId).pending === text) update(matchId, { pending: null })
}

export function learnBoard(matchId: string, text: string): void {
  update(matchId, { synced: text })
}

export function forgetBoards(matchId?: string): void {
  if (matchId === undefined) boards.clear()
  else boards.delete(matchId)
  for (const listener of listeners) listener()
}

// The matches with a board to send, as one string, so a React store can
// compare it.
export function matchesWithPending(): string {
  return [...boards]
    .filter(([, { pending }]) => pending !== null)
    .map(([matchId]) => matchId)
    .sort()
    .join(' ')
}

// The game numbers whose points on screen differ from the server's.
export function unsyncedGames(shown: GamePoints[], synced: GamePoints[]): Set<number> {
  const games = new Set<number>()
  for (let index = 0; index < Math.max(shown.length, synced.length); index++) {
    if (shown[index]?.join('-') !== synced[index]?.join('-')) games.add(index + 1)
  }
  return games
}

export type Shown = { text: string; fragment: Fragment }

// Whether a tab with nothing to send replaces the board on screen with one
// it pulled. It follows the server while it shows what it last synced, or
// nothing. A board from a link, such as a result under review, gives way
// only to a newer one, so opening an older board never undoes it.
export function adopts(shown: Shown, pulled: Shown, synced: string | null): boolean {
  if (pulled.text === shown.text) return false
  if (shown.fragment.kind === 'empty' || shown.text === synced) return true
  return issuedAtOf(pulled.fragment) > issuedAtOf(shown.fragment)
}

function issuedAtOf(fragment: Fragment): number {
  return fragment.kind === 'empty' ? -Infinity : fragment.issuedAt
}
