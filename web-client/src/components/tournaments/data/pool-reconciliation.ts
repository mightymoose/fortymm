// **A pool count is a number of pool ROWS** (ADR
// 20260808-an-events-pool-count-is-its-pool-rows-and-a-derived-count-is-a-projection):
// nothing stores a pool count of its own, so a director who types `6` on the Draw
// structure tab is asking for six rows, and this module is what turns that number into the
// list the editor already sends.
//
// **It is a pure function, and it renders nothing.** Two callers need the same answer and
// must not each work it out: the Pool count row (typing a number), and — next — the
// disagreement panel's `Use {n} pools of {size}` resolution, which the ADR describes as
// the same append through the same seam. A second implementation would be a second way to
// mint a pool, which is exactly what point 3 of the ADR's decision forbids.
//
// **What it never does is write.** It returns the new list *and* the rows that list drops,
// because dropping a row discards a reservation — its window and its table selections —
// and the caller has to be able to name what will go before it goes (ADR
// 20260806-a-confirm-prices-an-irreversible-act-a-freeze-explains-an-illegal-one).

import { poolLetter } from './draw-structure'
import { addedPool } from './pool-entries'
import type { PoolEntry, Slot } from './types'

/** What a pool joining at `index` is called — `Pool A`, `Pool B`, … and past `Pool Z` the
 * spreadsheet's `Pool AA` (`poolLetter`).
 *
 * **The ONE place a default pool name is minted**, shared with the Table pools tab's own
 * `Add pool`, because the ADR's "continuing the existing letter sequence" is a promise
 * about one sequence and not about two that happen to agree for the first 26. (They did
 * not agree past it: the tab used to spell the letter `String.fromCharCode(65 + n)`, which
 * prints `Pool [` for the 27th pool — reachable now that the Pool count box admits 512.) */
export const poolNameAt = (index: number): string => `Pool ${poolLetter(index)}`

/** The result of reconciling a pool list to a count: the list to write, and — when the
 * count went **down** — the rows it drops.
 *
 * The two are returned together rather than derived twice, because the caller needs both
 * halves of the same decision: what to save, and what to warn about first. `removed` is
 * empty for every non-destructive reconciliation, so "is this destructive?" is
 * `removed.length > 0` and never a comparison of two lengths done a second time. */
export interface PoolReconciliation {
  /** The pools the event should have, in order — what the editor sends. */
  pools: PoolEntry[]
  /** The rows this drops, in the order they sit in today (so the copy names them the way
   * the Table pools tab lists them). Empty unless the count went down. */
  removed: PoolEntry[]
}

/**
 * Reconcile an event's pool rows to a director-typed pool **count**.
 *
 * **Raising it appends.** New rows continue the letter sequence, take the **last existing
 * pool's** date and window — so the director is not handed a blank card to complete — and
 * reserve **no tables**. A pool with no tables is a known, reported state (#1072), which is
 * why nothing here invents a table selection the director never made.
 *
 * With no pool to copy from, the fallback is the Table pools tab's own first-pool
 * behaviour: the **event's** window. One convention, stated once — this module and
 * `PoolsSection.addPool` mint a pool the same way or they mint two kinds of pool.
 *
 * **Lowering it drops from the END**, which is where `append` puts new pools and therefore
 * the order the director built. The survivors are the *same entries*, arms and all: a
 * `kept` pool goes on citing the id the server minted, so lowering a count and raising it
 * again does not silently remove and recreate every pool of the event (and orphan nothing,
 * because a cut event's pool set is frozen before this can be reached).
 *
 * `count` is the director's, already through the box's own bounds
 * (`acceptedManualEntry`: an integer in `1 … 512`, or `null` for a cleared box, which is
 * not a count and never reaches here). `Math.max(1, …)` is the same floor every other
 * reader of a manual number applies — no pools is not a smaller draw, it is no draw.
 */
export function reconcilePoolsToCount(
  pools: readonly PoolEntry[],
  count: number,
  eventSlot: Slot,
): PoolReconciliation {
  const target = Math.max(1, Math.trunc(count))
  if (target < pools.length) {
    return { pools: pools.slice(0, target), removed: pools.slice(target) }
  }
  // The window a new pool inherits: the last pool's, else the event's. Copied, never
  // shared — a `Slot` handed to two entries by reference is one window both cards edit.
  const source = pools.length > 0 ? pools[pools.length - 1].slot : eventSlot
  const appended = Array.from({ length: target - pools.length }, (_, i) =>
    addedPool({
      name: poolNameAt(pools.length + i),
      slot: { ...source },
      tableIds: [],
    }),
  )
  return { pools: [...pools, ...appended], removed: [] }
}
