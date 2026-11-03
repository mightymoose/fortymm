import { useSyncExternalStore } from 'react'
import { checkGame, type GamePoints, type Side } from './board'

// A match's scratchpad on this device: the board as this device last saw
// it, and the changes made here that the server hasn't taken yet. Saving
// never waits on the network. `sync.ts` sends the outbox in the background.
// It lives in localStorage, one record per match, so it survives a reload
// with no signal and tabs on one match stay in step.

export type Scorer = { playerId: string; name: string }

export type SavedGame = { points: GamePoints; savedBy: Scorer }

export type Submitted = { phase: 'submitted'; by: string; games: GamePoints[]; winner: Side; submittedAt: string }

export type Submission = { phase: 'open' } | Submitted

export type Board = {
  // By game number.
  games: Readonly<Record<number, SavedGame>>
  submission: Submission
}

// One edit to a board, as the outbox keeps it and the server takes it.
export type Change = { id: string } & (
  | { kind: 'save'; game: number; points: GamePoints; savedBy: Scorer }
  | { kind: 'clear'; game: number }
  | { kind: 'submit'; submission: Submitted }
  | { kind: 'reopen' }
)

export type Scratchpad = Board & { outbox: readonly Change[] }

const EMPTY: Scratchpad = { games: {}, submission: { phase: 'open' }, outbox: [] }

export function storageKey(matchId: string): string {
  return `fortymm-scratchpad:${matchId}`
}

// The board after `change`, or null when the board refuses it: a game
// write once the result is submitted.
export function applyChange(board: Board, change: Change): Board | null {
  switch (change.kind) {
    case 'save':
      if (board.submission.phase === 'submitted') return null
      return { ...board, games: { ...board.games, [change.game]: { points: change.points, savedBy: change.savedBy } } }
    case 'clear': {
      if (board.submission.phase === 'submitted') return null
      const games = { ...board.games }
      delete games[change.game]
      return { ...board, games }
    }
    case 'submit':
      return { ...board, submission: change.submission }
    case 'reopen':
      return { ...board, submission: { phase: 'open' } }
  }
}

// The games of `pad` as slots, indexed by game number less 1.
export function slotsOf(pad: Board, bestOf: number): (GamePoints | null)[] {
  return Array.from({ length: bestOf }, (_, index) => pad.games[index + 1]?.points ?? null)
}

export function useScratchpad(matchId: string): Scratchpad {
  return useSyncExternalStore(subscribe, () => read(storageKey(matchId)))
}

type NewChange = Change extends infer C ? (C extends Change ? Omit<C, 'id'> : never) : never

// Applies `change` here and queues it for the server. False when the board
// refuses it.
function record(matchId: string, change: NewChange): boolean {
  const key = storageKey(matchId)
  const pad = read(key)
  const queued = { ...change, id: crypto.randomUUID() } as Change
  const board = applyChange(pad, queued)
  if (!board) return false
  store(key, { ...pad, ...board, outbox: [...pad.outbox, queued] })
  return true
}

export function saveGame(matchId: string, game: number, points: GamePoints, savedBy: Scorer): boolean {
  return record(matchId, { kind: 'save', game, points, savedBy })
}

export function clearGame(matchId: string, game: number): boolean {
  return record(matchId, { kind: 'clear', game })
}

export function submitResult(
  matchId: string,
  submission: Omit<Submitted, 'phase' | 'submittedAt'>,
): boolean {
  return record(matchId, {
    kind: 'submit',
    submission: { phase: 'submitted', ...submission, submittedAt: new Date().toISOString() },
  })
}

export function reopen(matchId: string): boolean {
  return record(matchId, { kind: 'reopen' })
}

export function pendingChanges(matchId: string): readonly Change[] {
  return read(storageKey(matchId)).outbox
}

// The server took `id`, or refused it for good, so it leaves the outbox.
export function markSent(matchId: string, id: string): void {
  const key = storageKey(matchId)
  const pad = read(key)
  if (!pad.outbox.some((change) => change.id === id)) return
  store(key, { ...pad, outbox: pad.outbox.filter((change) => change.id !== id) })
}

// The demo server keeps its own board under another key, in the same shape.
export function readBoard(key: string): Board {
  const { games, submission } = read(key)
  return { games, submission }
}

export function writeBoard(key: string, board: Board): void {
  store(key, { ...board, outbox: [] })
}

const listeners = new Set<() => void>()

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Fired only in the other tabs.
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

function store(key: string, pad: Scratchpad): void {
  write(key, JSON.stringify(pad))
  for (const listener of listeners) listener()
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

function read(key: string): Scratchpad {
  const raw = load(key)
  const cached = parsed.get(key)
  if (cached && cached.raw === raw) return cached.pad
  const pad = raw === null ? EMPTY : parse(raw)
  parsed.set(key, { raw, pad })
  return pad
}

// Another tab, or an older build, may have written the record, so it is
// checked like any outside input. A game or change that isn't valid is left
// out.
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
      if (saved && isGameNumber(Number(number))) games[Number(number)] = saved
    }
  }
  const outbox = Array.isArray(data.outbox)
    ? data.outbox.map(parseChange).filter((change) => change !== null)
    : []
  return { games, submission: parseSubmission(data.submission) ?? { phase: 'open' }, outbox }
}

function isGameNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9
}

function parseScorer(scorer: unknown): Scorer | null {
  if (!isRecord(scorer)) return null
  const { playerId, name } = scorer
  return typeof playerId === 'string' && typeof name === 'string' ? { playerId, name } : null
}

function parseGame(game: unknown): SavedGame | null {
  if (!isRecord(game)) return null
  const points = parsePoints(game.points)
  const savedBy = parseScorer(game.savedBy)
  return points && savedBy ? { points, savedBy } : null
}

function parsePoints(points: unknown): GamePoints | null {
  if (!Array.isArray(points) || points.length !== 2) return null
  const [a, b] = points as unknown[]
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null
  const pair: GamePoints = [a as number, b as number]
  return checkGame(pair).kind === 'legal' ? pair : null
}

function parseSubmission(submission: unknown): Submitted | null {
  if (!isRecord(submission) || submission.phase !== 'submitted') return null
  const { by, games, winner, submittedAt } = submission
  if (typeof by !== 'string' || typeof submittedAt !== 'string' || (winner !== 0 && winner !== 1)) {
    return null
  }
  if (!Array.isArray(games)) return null
  const points = games.map(parsePoints)
  if (points.some((game) => game === null)) return null
  return { phase: 'submitted', by, games: points as GamePoints[], winner, submittedAt }
}

function parseChange(change: unknown): Change | null {
  if (!isRecord(change) || typeof change.id !== 'string') return null
  const { id } = change
  switch (change.kind) {
    case 'save': {
      const points = parsePoints(change.points)
      const savedBy = parseScorer(change.savedBy)
      return isGameNumber(change.game) && points && savedBy
        ? { id, kind: 'save', game: change.game, points, savedBy }
        : null
    }
    case 'clear':
      return isGameNumber(change.game) ? { id, kind: 'clear', game: change.game } : null
    case 'submit': {
      const submission = parseSubmission(change.submission)
      return submission ? { id, kind: 'submit', submission } : null
    }
    case 'reopen':
      return { id, kind: 'reopen' }
    default:
      return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
