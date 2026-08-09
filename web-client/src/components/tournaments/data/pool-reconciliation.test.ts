import { describe, expect, it } from 'vitest'

import { addedPool, keepPool } from './pool-entries'
import { poolNameAt, reconcilePoolsToCount } from './pool-reconciliation'
import { buildPool } from './seed.factory'
import type { PoolEntry, Slot } from './types'

/** The event's own window — what a first pool inherits when there is no pool to copy. */
const EVENT_SLOT: Slot = { date: '2026-06-13', start: '08:00', end: '20:00' }
/** A window a director has already narrowed on the last pool card, so "the new row takes
 * the LAST pool's window" is distinguishable from "the new row takes the event's". */
const LAST_SLOT: Slot = { date: '2026-06-14', start: '13:00', end: '16:30' }

/** `n` stored pools, named and slotted as the Table pools tab would have them. */
const storedPools = (n: number): PoolEntry[] =>
  Array.from({ length: n }, (_, i) =>
    keepPool(
      buildPool({
        id: `p-${i + 1}`,
        name: poolNameAt(i),
        slot: i === n - 1 ? LAST_SLOT : EVENT_SLOT,
        tableIds: [`t${i + 1}`],
        position: i,
      }),
    ),
  )

describe('poolNameAt', () => {
  it('names the letter sequence, and keeps naming it past Z', () => {
    expect(poolNameAt(0)).toBe('Pool A')
    expect(poolNameAt(1)).toBe('Pool B')
    // The 27th pool, reachable now that the Pool count box admits 512 — `Pool AA`, and
    // not the `Pool [` a raw `String.fromCharCode(65 + n)` prints.
    expect(poolNameAt(26)).toBe('Pool AA')
  })
})

describe('reconcilePoolsToCount — raising the count', () => {
  it('appends rows until the list is the count the director typed', () => {
    const { pools, removed } = reconcilePoolsToCount(storedPools(4), 6, EVENT_SLOT)

    expect(pools).toHaveLength(6)
    expect(removed).toEqual([])
  })

  /** The four pools the event already had are the SAME entries — same arm, same id. A
   * reconciliation that rebuilt them would remove and recreate every pool of the event
   * on a keystroke. */
  it('leaves every existing pool exactly as it was', () => {
    const before = storedPools(4)
    const { pools } = reconcilePoolsToCount(before, 6, EVENT_SLOT)

    expect(pools.slice(0, 4)).toEqual(before)
  })

  /** ⚠️ **No id, ever.** `PoolWrite` is `extra="forbid"` and has no `id` field, so a
   * client-minted one is a 422 naming the entry (ADR 20260801). The `added` arm is what
   * makes that unsayable, and this is the assertion that the append uses it. */
  it('mints the new rows with no id at all', () => {
    const { pools } = reconcilePoolsToCount(storedPools(4), 6, EVENT_SLOT)

    for (const entry of pools.slice(4)) {
      expect(entry.kind).toBe('added')
      expect('id' in entry).toBe(false)
    }
  })

  it('continues the letter sequence rather than restarting it', () => {
    const { pools } = reconcilePoolsToCount(storedPools(4), 6, EVENT_SLOT)

    expect(pools.map((p) => p.name)).toEqual([
      'Pool A',
      'Pool B',
      'Pool C',
      'Pool D',
      'Pool E',
      'Pool F',
    ])
  })

  /** The director is not handed a blank card to complete (ADR 20260808): a new row takes
   * the window the last pool already runs in. */
  it('takes the last existing pool’s date and window', () => {
    const { pools } = reconcilePoolsToCount(storedPools(4), 6, EVENT_SLOT)

    expect(pools[4].slot).toEqual(LAST_SLOT)
    expect(pools[5].slot).toEqual(LAST_SLOT)
  })

  /** Copied, never shared. Two entries holding one `Slot` by reference is one window that
   * two pool cards edit at once. */
  it('gives each new row a window of its own', () => {
    const before = storedPools(4)
    const { pools } = reconcilePoolsToCount(before, 6, EVENT_SLOT)

    expect(pools[4].slot).not.toBe(before[3].slot)
    expect(pools[4].slot).not.toBe(pools[5].slot)
  })

  /** **No tables**, because the ADR says so: an empty pool is a known, reported state
   * (#1072), and a table selection the director never made is a reservation invented on
   * their behalf. */
  it('reserves no tables', () => {
    const { pools } = reconcilePoolsToCount(storedPools(4), 6, EVENT_SLOT)

    expect(pools[4].tableIds).toEqual([])
    expect(pools[5].tableIds).toEqual([])
  })

  /** With nothing to copy from, the fallback is the Table pools tab's own first-pool
   * behaviour — `Pool A`, the event's window, no tables — and not a second convention. */
  it('falls back to the event’s own window for a first pool', () => {
    const { pools } = reconcilePoolsToCount([], 2, EVENT_SLOT)

    expect(pools).toHaveLength(2)
    expect(pools.map((p) => p.name)).toEqual(['Pool A', 'Pool B'])
    expect(pools[0].slot).toEqual(EVENT_SLOT)
    expect(pools[1].slot).toEqual(EVENT_SLOT)
  })
})

describe('reconcilePoolsToCount — lowering the count', () => {
  /** From the END, which is where `append` puts a new pool and therefore the order the
   * director built. */
  it('drops rows from the end and names the ones it dropped', () => {
    const before = storedPools(6)
    const { pools, removed } = reconcilePoolsToCount(before, 4, EVENT_SLOT)

    expect(pools).toEqual(before.slice(0, 4))
    expect(removed).toEqual(before.slice(4))
    expect(removed.map((p) => p.name)).toEqual(['Pool E', 'Pool F'])
  })

  /** The surviving pools go on citing the ids the server minted. A `slice` preserves the
   * arms; anything that rebuilt them would be an id-keyed diff removing four pools and
   * adding four back. */
  it('keeps the survivors’ server ids', () => {
    const { pools } = reconcilePoolsToCount(storedPools(6), 4, EVENT_SLOT)

    expect(pools.every((p) => p.kind === 'kept')).toBe(true)
    expect(pools.map((p) => (p.kind === 'kept' ? p.id : null))).toEqual([
      'p-1',
      'p-2',
      'p-3',
      'p-4',
    ])
  })

  /** A pool the server has never seen is dropped like any other — the last one added is
   * the first one to go. */
  it('drops an unsaved pool the same way', () => {
    const before: PoolEntry[] = [
      ...storedPools(1),
      addedPool({ name: 'Pool B', slot: EVENT_SLOT, tableIds: [] }),
    ]
    const { pools, removed } = reconcilePoolsToCount(before, 1, EVENT_SLOT)

    expect(pools).toEqual(before.slice(0, 1))
    expect(removed).toEqual(before.slice(1))
  })
})

describe('reconcilePoolsToCount — the count already holds', () => {
  it('changes nothing and removes nothing', () => {
    const before = storedPools(4)
    const { pools, removed } = reconcilePoolsToCount(before, 4, EVENT_SLOT)

    expect(pools).toEqual(before)
    expect(removed).toEqual([])
  })
})

describe('reconcilePoolsToCount — the floor', () => {
  /** The same `max(1, …)` every other reader of a manual number applies. A cleared box
   * sends `null` and never reaches here, but no pools is not a smaller draw. */
  it('never reconciles an event down to no pools', () => {
    const { pools, removed } = reconcilePoolsToCount(storedPools(3), 0, EVENT_SLOT)

    expect(pools).toHaveLength(1)
    expect(removed).toHaveLength(2)
  })
})
