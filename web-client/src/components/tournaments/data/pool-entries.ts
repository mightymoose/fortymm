// An event's pools as an **id-keyed diff** (ADR 20260801), on the client side of the
// wire: how a Table-pools edit is expressed, and how a pool the director just added is
// told apart from one the server already holds.
//
// The twin of `./table-catalogue`, one resource over, and it exists for the same two
// server-side facts:
//
// 1. **The server mints pool ids.** `PoolWrite` is `extra="forbid"` and has no `id`
//    field, so a client-minted one is a 422 naming the entry. A new pool therefore
//    carries no id at all — which is what `PoolEntry`'s `added` arm makes structurally
//    true rather than a rule to remember (`./types`).
// 2. **An uncited stored pool is removed**, and an entry citing an id the event does not
//    hold is a 422 on that entry (`['body','pools',i,'id']`) — never a quietly minted
//    pool, which would hand back a different id than was asked for while removing the
//    pool the client meant to keep.
//
// There is no classifier here to match `tableInUseRefusal`: the one refusal a pools edit
// can meet that a director may act on — the pool-set freeze under a cut draw — is a 409
// whose way out is "delete the draw", not "re-send with an opt-in". It is reported, in
// the server's own sentence, by the editor's failure banner (`./save-failure`).

import { genId } from './helpers'
import type { Pool, PoolDraft, PoolEntry } from './types'

/** "Keep this pool" — an entry citing a pool the server actually sent back. Built from
 * the whole `Pool`, so there is no way to cite an id that came from anywhere but a
 * read. */
export const keepPool = (pool: Pool): PoolEntry => ({
  kind: 'kept',
  id: pool.id,
  name: pool.name,
  slot: pool.slot,
  tableIds: pool.tableIds,
})

/** Every stored pool, cited — the "change nothing about the set" list. The base an edit
 * is built by filtering, appending to, or re-wording; it is what `eventToFormValues`
 * (`../tournament-detail-page/event-form`) seeds the editor's field array with, in
 * position order. */
export const keepPools = (pools: readonly Pool[]): PoolEntry[] => pools.map(keepPool)

/** "Add this pool" — **no id**, because the client has none to give (ADR 20260801).
 *
 * The `key` is a React key and only ever that (see `PoolEntry`): the cards are keyed on
 * something stable so an in-place `update()` re-renders a card instead of remounting it
 * and dropping the director's cursor, and a pool the server has never seen has nothing
 * else to be keyed on. It is not an id, is never sent, and cannot be mistaken for one —
 * the arm that has an id is a different arm. */
export const addedPool = (draft: PoolDraft): PoolEntry => ({
  kind: 'added',
  key: genId('new-pool'),
  ...draft,
})

/** What to key this entry's card — and its name error — on: the server's id for a pool
 * that has one, the client-side card key for one that does not.
 *
 * Keyed rather than indexed because an index renumbers: remove the first of three pools
 * and an index-keyed error message is suddenly red under the wrong box (a bug this
 * editor has already had once, `pools-section.test.tsx`). */
export const poolEntryKey = (entry: PoolEntry): string =>
  entry.kind === 'kept' ? entry.id : entry.key
