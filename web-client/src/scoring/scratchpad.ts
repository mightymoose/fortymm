import { useSyncExternalStore } from 'react'
import { z } from 'zod'
import { checkGame, type GamePoints } from './board'

// A match's scratchpad on this device: the board as this device last saw
// it, and an outbox of the changes made here that the server hasn't taken.
// Saving never waits on the network. `sync.ts` sends the outbox and pulls
// the server's board in the background. Each match is one localStorage
// record, so it survives a reload with no signal and tabs stay in step.

const gameNumber = z.int().min(1).max(9)

const points = z
  .tuple([z.int(), z.int()])
  .refine((pair): pair is GamePoints => checkGame(pair).kind === 'legal')

const scorer = z.object({ playerId: z.string(), name: z.string() })

const savedGame = z.object({ points, savedBy: scorer })

// `games` pins the games the player approved, since another device's save
// can reach the server before this submission does.
const submitted = z.object({
  phase: z.literal('submitted'),
  by: z.string(),
  games: z.array(points),
  submittedAt: z.string(),
})

const edit = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('save'), game: gameNumber, points, savedBy: scorer }),
  z.object({ kind: z.literal('clear'), game: gameNumber }),
  z.object({ kind: z.literal('submit'), submission: submitted }),
  z.object({ kind: z.literal('reopen') }),
])

const change = z.object({ id: z.string(), edit })

// Only the record's outline. Its games and changes are checked one by one,
// so one that isn't valid is left out rather than the whole record.
const outline = z.object({
  games: z.record(z.string(), z.unknown()).catch({}),
  submission: z.unknown(),
  outbox: z.array(z.unknown()).catch([]),
})

export type Scorer = z.infer<typeof scorer>
export type SavedGame = z.infer<typeof savedGame>
export type Submitted = z.infer<typeof submitted>
export type Submission = { phase: 'open' } | Submitted
export type Edit = z.infer<typeof edit>
// One edit to a board, as the outbox keeps it and the server takes it.
export type Change = z.infer<typeof change>

export type Board = {
  // By game number.
  games: Readonly<Record<number, SavedGame>>
  submission: Submission
}

export type Scratchpad = Board & { outbox: readonly Change[] }

const OPEN: Submission = { phase: 'open' }
const EMPTY: Scratchpad = { games: {}, submission: OPEN, outbox: [] }

export function storageKey(matchId: string): string {
  return `fortymm-scratchpad:${matchId}`
}

// The board after `edit`, or null when the board refuses it: a game write
// once the result is submitted. The device and the demo server both apply
// changes through it.
export function applyEdit(board: Board, edit: Edit): Board | null {
  switch (edit.kind) {
    case 'save':
      if (board.submission.phase === 'submitted') return null
      return { ...board, games: { ...board.games, [edit.game]: { points: edit.points, savedBy: edit.savedBy } } }
    case 'clear': {
      if (board.submission.phase === 'submitted') return null
      const games = { ...board.games }
      delete games[edit.game]
      return { ...board, games }
    }
    case 'submit':
      return { ...board, submission: edit.submission }
    case 'reopen':
      return { ...board, submission: OPEN }
  }
}

export function slotsOf(board: Board, bestOf: number): (GamePoints | null)[] {
  return Array.from({ length: bestOf }, (_, index) => board.games[index + 1]?.points ?? null)
}

export function useScratchpad(matchId: string): Scratchpad {
  return useSyncExternalStore(subscribe, () => read(storageKey(matchId)))
}

// Applies `edit` here and queues it for the server. False when the board
// refuses it.
function record(matchId: string, edit: Edit): boolean {
  const key = storageKey(matchId)
  const pad = read(key)
  const board = applyEdit(pad, edit)
  if (!board) return false
  store(key, { ...board, outbox: [...pad.outbox, { id: crypto.randomUUID(), edit }] })
  return true
}

export function saveGame(matchId: string, game: number, points: GamePoints, savedBy: Scorer): boolean {
  return record(matchId, { kind: 'save', game, points, savedBy })
}

export function clearGame(matchId: string, game: number): boolean {
  return record(matchId, { kind: 'clear', game })
}

export function submitResult(matchId: string, by: string, games: GamePoints[]): boolean {
  return record(matchId, {
    kind: 'submit',
    submission: { phase: 'submitted', by, games, submittedAt: new Date().toISOString() },
  })
}

export function reopen(matchId: string): boolean {
  return record(matchId, { kind: 'reopen' })
}

export function pendingChanges(matchId: string): readonly Change[] {
  return read(storageKey(matchId)).outbox
}

// The ids of the matches whose outbox has changes, sorted and joined by
// spaces, so useSyncExternalStore gets an equal value while they don't
// change.
export function matchesWithChanges(): string {
  const prefix = storageKey('')
  return allKeys()
    .filter((key) => key.startsWith(prefix) && read(key).outbox.length > 0)
    .map((key) => key.slice(prefix.length))
    .sort()
    .join(' ')
}

// Takes the server's board as the base, with this device's unsent changes
// applied on top again, so a pull never undoes what was entered here.
export function receiveBoard(matchId: string, server: Board): void {
  const key = storageKey(matchId)
  const { outbox } = read(key)
  const board = outbox.reduce<Board>((board, change) => applyEdit(board, change.edit) ?? board, server)
  store(key, { ...board, outbox })
}

// The server took `id`, or refused it for good, so it leaves the outbox.
export function markSent(matchId: string, id: string): void {
  const key = storageKey(matchId)
  const pad = read(key)
  if (!pad.outbox.some((change) => change.id === id)) return
  store(key, { ...pad, outbox: pad.outbox.filter((change) => change.id !== id) })
}

// The demo server keeps its board under its own key, in the same record.
export function readBoard(key: string): Board {
  const { games, submission } = read(key)
  return { games, submission }
}

export function writeBoard(key: string, board: Board): void {
  store(key, { ...board, outbox: [] })
}

// Deletes every record whose key `matches`, to start a demo match over.
export function forgetRecords(matches: (key: string) => boolean): void {
  for (const key of allKeys().filter(matches)) {
    memory.delete(key)
    try {
      localStorage.removeItem(key)
    } catch {
      // It was only in memory.
    }
  }
  notify()
}

const listeners = new Set<() => void>()

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // The browser fires it only in the other tabs.
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

function notify(): void {
  for (const listener of listeners) listener()
}

// Holds a record whose write to localStorage threw, as it can in a private
// window or with storage full, so the page still works in this tab.
const memory = new Map<string, string>()

function allKeys(): string[] {
  const keys = new Set(memory.keys())
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key !== null) keys.add(key)
    }
  } catch {
    // Only this tab's memory, then.
  }
  return [...keys]
}

// An empty record is removed rather than written, so a pull of an empty
// board leaves nothing behind.
function store(key: string, pad: Scratchpad): void {
  const empty = Object.keys(pad.games).length === 0 && pad.submission.phase === 'open' && pad.outbox.length === 0
  const raw = JSON.stringify(pad)
  memory.delete(key)
  try {
    if (empty) localStorage.removeItem(key)
    else localStorage.setItem(key, raw)
  } catch {
    memory.set(key, raw)
  }
  notify()
}

// A write can fail while reads still work, as when storage is full, so a
// record in memory is newer than the one in storage.
function load(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
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
// checked like any outside input.
function parse(raw: string): Scratchpad {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return EMPTY
  }
  const record = outline.safeParse(json)
  if (!record.success) return EMPTY
  const games: Record<number, SavedGame> = {}
  for (const [key, value] of Object.entries(record.data.games)) {
    const number = gameNumber.safeParse(Number(key))
    const game = savedGame.safeParse(value)
    if (number.success && game.success) games[number.data] = game.data
  }
  const submission = submitted.safeParse(record.data.submission)
  return {
    games,
    submission: submission.success ? submission.data : OPEN,
    outbox: record.data.outbox.flatMap((value) => {
      const parsedChange = change.safeParse(value)
      return parsedChange.success ? [parsedChange.data] : []
    }),
  }
}
