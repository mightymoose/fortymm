import { describe, expect, it } from 'vitest'

import { addedPool, keepPool, keepPools, poolEntryKey } from './pool-entries'
import { buildPool, buildTenPools } from './seed.factory'
import type { Slot } from './types'

/** Any window at all — none of these claims turn on when a pool plays. */
const SLOT: Slot = { date: '2026-06-13', start: '09:00', end: '12:30' }

describe('keepPool', () => {
  // The point of taking a whole `Pool` rather than an id: the only ids that can reach
  // the wire are ids a read handed back (ADR 20260801). One this event does not hold is
  // a 422 on that entry, so an id the client made up is not a mistake it may make.
  it('cites the pool the server sent, with the words it holds today', () => {
    expect(
      keepPool(buildPool({ id: 'p-7', name: 'Pool G', tableIds: ['t3'] })),
    ).toEqual({
      kind: 'kept',
      id: 'p-7',
      name: 'Pool G',
      slot: SLOT,
      tableIds: ['t3'],
    })
  })

  /** ⚠️ **The `position` does NOT come along.** It is the server's, assigned from the
   * index of the entry in the list it is sent, and both write shapes are
   * `extra="forbid"` — so a position that rode along on an entry would be a 422 naming
   * the field, and the director's whole save refused for a key they never typed. */
  it('drops the server-assigned position', () => {
    const entry = keepPool(buildPool({ position: 4 }))
    expect('position' in entry).toBe(false)
  })
})

describe('keepPools', () => {
  /** The no-op diff, and the reason it has to exist: under an id-keyed diff a stored
   * pool **no entry cites** is removed. So "I am editing something else about this
   * event" is spelled by citing every pool, not by sending none. */
  it('cites every stored pool, in the order it was given them', () => {
    const pools = buildTenPools()
    const entries = keepPools(pools)

    expect(entries).toHaveLength(10)
    expect(entries.map(poolEntryKey)).toEqual(pools.map((p) => p.id))
    expect(new Set(entries.map((e) => e.kind))).toEqual(new Set(['kept']))
  })

  it('has nothing to say about an event with no pools', () => {
    expect(keepPools([])).toEqual([])
  })
})

describe('addedPool', () => {
  /** The whole chore in one assertion: a pool the server has never seen carries **no id
   * key at all**. `PoolWrite` has no such field and is `extra="forbid"`, so a supplied
   * one is a 422 on `body.pools[i].id` — and the union arm is what makes that
   * unsayable rather than merely untrue today. */
  it('carries no id, because the client has none to give', () => {
    const entry = addedPool({ name: 'Pool B', slot: SLOT, tableIds: ['t1'] })

    expect(entry.kind).toBe('added')
    expect('id' in entry).toBe(false)
    expect(entry).toMatchObject({ name: 'Pool B', slot: SLOT, tableIds: ['t1'] })
  })

  /** Two pools added in the same session must be two cards, not one rendered twice: the
   * key is what React and `poolNameIssues` address a card by, and every event has a
   * “Pool A”, so it cannot be derived from anything the director typed. */
  it('mints a distinct card key per pool', () => {
    const draft = { name: 'Pool A', slot: SLOT, tableIds: [] }
    expect(poolEntryKey(addedPool(draft))).not.toBe(
      poolEntryKey(addedPool(draft)),
    )
  })
})

describe('poolEntryKey', () => {
  it('is the server’s id for a stored pool and the card key for a new one', () => {
    expect(poolEntryKey(keepPool(buildPool({ id: 'p-1' })))).toBe('p-1')

    const added = addedPool({ name: 'Pool B', slot: SLOT, tableIds: [] })
    expect(poolEntryKey(added)).toBe(
      added.kind === 'added' ? added.key : undefined,
    )
  })
})
