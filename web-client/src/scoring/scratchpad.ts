import { useSyncExternalStore } from 'react'
import { checkGame, type GamePoints, type Side } from './board'

// A match's scratchpad: the games anyone has entered so far, and whether a
// player has submitted the result. It lives in this browser's localStorage,
// one record per match, so tabs on one match stay in step. The board that
// everyone at the table shares, held by the server, comes later.

export type Scorer = { playerId: string; name: string }

export type SavedGame = { points: GamePoints; savedBy: Scorer }

export type Submission =
  | { phase: 'open' }
  | { phase: 'submitted'; by: string; games: GamePoints[]; winner: Side; submittedAt: string }

export type Scratchpad = {
  // By game number.
  games: Readonly<Record<number, SavedGame>>
  submission: Submission
}

const EMPTY: Scratchpad = { games: {}, submission: { phase: 'open' } }

export function storageKey(matchId: string): string {
  return `fortymm-scratchpad:${matchId}`
}

// The games of `pad` as slots, indexed by game number less 1.
export function slotsOf(pad: Scratchpad, bestOf: number): (GamePoints | null)[] {
  return Array.from({ length: bestOf }, (_, index) => pad.games[index + 1]?.points ?? null)
}

export function useScratchpad(matchId: string): Scratchpad {
  return useSyncExternalStore(subscribe, () => read(matchId))
}

// Saves a game's score. Refused, returning false, once the result is
// submitted.
export function saveGame(matchId: string, game: number, points: GamePoints, savedBy: Scorer): boolean {
  return update(matchId, (pad) => {
    if (pad.submission.phase === 'submitted') return null
    return { ...pad, games: { ...pad.games, [game]: { points, savedBy } } }
  })
}

export function clearGame(matchId: string, game: number): boolean {
  return update(matchId, (pad) => {
    if (pad.submission.phase === 'submitted') return null
    const games = { ...pad.games }
    delete games[game]
    return { ...pad, games }
  })
}

export function submitResult(
  matchId: string,
  submission: Omit<Extract<Submission, { phase: 'submitted' }>, 'phase' | 'submittedAt'>,
): boolean {
  return update(matchId, (pad) => ({
    ...pad,
    submission: { phase: 'submitted', ...submission, submittedAt: new Date().toISOString() },
  }))
}

export function reopen(matchId: string): boolean {
  return update(matchId, (pad) => ({ ...pad, submission: { phase: 'open' } }))
}

function update(matchId: string, change: (pad: Scratchpad) => Scratchpad | null): boolean {
  const next = change(read(matchId))
  if (!next) return false
  write(storageKey(matchId), JSON.stringify(next))
  for (const listener of listeners) listener()
  return true
}

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Fired only in the other tabs.
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

// Used only when localStorage throws, as it can in a private window, so the
// page still works in this tab.
const memory = new Map<string, string>()

function load(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return memory.get(key) ?? null
  }
}

function write(key: string, raw: string): void {
  try {
    localStorage.setItem(key, raw)
  } catch {
    memory.set(key, raw)
  }
}

// useSyncExternalStore needs the same object back while the record hasn't
// changed.
const parsed = new Map<string, { raw: string | null; pad: Scratchpad }>()

function read(matchId: string): Scratchpad {
  const key = storageKey(matchId)
  const raw = load(key)
  const cached = parsed.get(key)
  if (cached && cached.raw === raw) return cached.pad
  const pad = raw === null ? EMPTY : parse(raw)
  parsed.set(key, { raw, pad })
  return pad
}

// Another tab, or an older build, may have written the record, so it is
// checked like any outside input. A game that isn't legal is left out.
function parse(raw: string): Scratchpad {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return EMPTY
  }
  if (!isRecord(data)) return EMPTY
  const games: Record<number, SavedGame> = {}
  if (isRecord(data.games)) {
    for (const [number, game] of Object.entries(data.games)) {
      const saved = parseGame(game)
      if (saved && /^[1-9]$/.test(number)) games[Number(number)] = saved
    }
  }
  return { games, submission: parseSubmission(data.submission) }
}

function parseGame(game: unknown): SavedGame | null {
  if (!isRecord(game) || !isRecord(game.savedBy)) return null
  const points = parsePoints(game.points)
  const { playerId, name } = game.savedBy
  if (!points || typeof playerId !== 'string' || typeof name !== 'string') return null
  return { points, savedBy: { playerId, name } }
}

function parsePoints(points: unknown): GamePoints | null {
  if (!Array.isArray(points) || points.length !== 2) return null
  const [a, b] = points as unknown[]
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null
  const pair: GamePoints = [a as number, b as number]
  return checkGame(pair).kind === 'legal' ? pair : null
}

function parseSubmission(submission: unknown): Submission {
  if (!isRecord(submission) || submission.phase !== 'submitted') return { phase: 'open' }
  const { by, games, winner, submittedAt } = submission
  if (typeof by !== 'string' || typeof submittedAt !== 'string' || (winner !== 0 && winner !== 1)) {
    return { phase: 'open' }
  }
  if (!Array.isArray(games)) return { phase: 'open' }
  const points = games.map(parsePoints)
  if (points.some((game) => game === null)) return { phase: 'open' }
  return { phase: 'submitted', by, games: points as GamePoints[], winner, submittedAt }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
