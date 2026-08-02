// The table catalogue as an **id-keyed diff** (ADR 20260801), on the client side of the
// wire: how a Tables-tab edit is expressed, and how the one refusal it can meet is
// recognised.
//
// Two facts drive everything here, and both are the server's:
//
// 1. **The server mints table ids.** `TournamentTableWrite` is `extra="forbid"` and has
//    no `id` field, so a client-minted one is a 422 naming the row. A new entry
//    therefore carries no id at all — which is what `TournamentTableEntry`'s `added`
//    arm makes structurally true rather than a rule to remember (`./types`).
// 2. **An uncited stored table is removed** — and a removal that would strand matches
//    already placed at that table is **refused with a 409**, unless the write says
//    `unplace_fixtures_on_removed_tables: true`. The refusal is the server's own
//    sentence, written for a director to act on, and it is the reason this module has
//    a classifier at all.

import { ApiError } from '@/api/client'

import { saveFailure } from './save-failure'
import type { TournamentTable, TournamentTableEntry } from './types'

/** "Keep this table" — an entry citing a row the server actually sent back. Takes the
 * whole `TournamentTable` rather than an id, so there is no way to cite an id that
 * came from anywhere but a read. */
export const keepTable = (table: TournamentTable): TournamentTableEntry => ({
  kind: 'kept',
  table,
})

/** Every stored table, cited — the "change nothing" catalogue. What a surface that is
 * editing something *else* about the tournament sends, and the base a Tables-tab edit
 * is built by filtering or appending. */
export const keepTables = (
  tables: readonly TournamentTable[],
): TournamentTableEntry[] => tables.map(keepTable)

/** "Add this table" — no id, because the client has none to give (ADR 20260801). */
export const addTable = (label: string, court: string): TournamentTableEntry => ({
  kind: 'added',
  label,
  court,
})

/**
 * The server's sentence when a catalogue edit was refused because it would remove a
 * table **matches are placed at** — or `null` when the failure is anything else.
 *
 * This is the one refusal a client may answer with a *question* instead of an error,
 * because the server's 409 explicitly names the way through: send the same edit again
 * with the opt-in. So the classification has to be narrow, and it is narrow in two
 * ways at once:
 *
 * - **the status must be 409.** `saveFailure`'s `refused` arm is broader than this
 *   refusal — a 403 ("you can only modify tournaments you created") lands in it too,
 *   and re-sending *that* with an opt-in flag would refuse identically while looking,
 *   to the director, like the app had asked them to authorise their own lockout.
 * - **the body must carry a sentence.** A 409 with no readable `detail` is not
 *   something to put in a dialog: the whole content of the confirm IS the server's
 *   prose (it names the tables, the match count, and both ways out), so with nothing
 *   to show there is no question to ask, and the failure takes the ordinary path.
 *
 * The sentence is rendered **verbatim** — the ADR-0968 fallback, the case where the
 * API wrote for a human rather than for a validator. Nothing here rewords it: it names
 * the tables by label and the number of matches, which no client can reconstruct.
 */
export function tableInUseRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const failure = saveFailure(error)
  return failure.kind === 'refused' ? failure.message : null
}
