import { ApiUnreachable } from '../api/errors'

// Stands in for the API's match routes until they exist. It keeps the
// latest board per match, the fragment's text, so spectators and
// tournament directors can watch a match. Each call waits, as a request
// to the API does, so syncing can be seen.

const LATENCY_MS = 300

// Moves on between tests, so a request still on its way can't land in the
// next one.
let generation = 0

export function dropRequestsInFlight(): void {
  generation += 1
}

async function send<T>(request: string, work: () => T): Promise<T> {
  const started = generation
  await new Promise((resolve) => setTimeout(resolve, LATENCY_MS))
  if (generation !== started) {
    throw new ApiUnreachable(request, { cause: new Error('The requests in flight were dropped') })
  }
  return work()
}

const PREFIX = 'fortymm-demo-server:'
// Used only when localStorage throws.
const boardsInMemory = new Map<string, string>()

// The board every device synced last, or null when none has.
export function serverBoard(matchId: string): string | null {
  try {
    return localStorage.getItem(PREFIX + matchId)
  } catch {
    return boardsInMemory.get(matchId) ?? null
  }
}

export function setServerBoard(matchId: string, text: string): void {
  try {
    localStorage.setItem(PREFIX + matchId, text)
  } catch {
    boardsInMemory.set(matchId, text)
  }
}

export function putBoard(matchId: string, text: string): Promise<void> {
  return send(`PUT /v1/matches/${matchId}/board`, () => setServerBoard(matchId, text))
}
