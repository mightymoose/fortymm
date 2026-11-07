import type { ApiClient } from '../api/client'
import { send } from '../api/queries'
import { hex } from '../signing/bytes'
import { fromBase64url } from '../signing/text'

// A hall's weak signal can hold a request far longer than a failed one
// takes, and the sync sends nothing else while one is on its way.
const TIMEOUT_MS = 10_000

// Sends a board, the fragment's text, to the API, which keeps the newest.
// `keepalive` lets a board saved just before the page closes still go.
export async function pushBoard(api: ApiClient, matchId: string, board: string): Promise<void> {
  await send(
    `POST /v1/matches/${matchId}/boards`,
    api.POST('/v1/matches/{match_id}/boards', {
      params: { path: { match_id: matchId } },
      body: { board: hex(fromBase64url(board)) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      keepalive: true,
    }),
  )
}
