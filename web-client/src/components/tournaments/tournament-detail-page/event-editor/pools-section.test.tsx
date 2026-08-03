import userEvent from '@testing-library/user-event'

import { fireEvent, screen } from '@/test/utilities'

import { poolEntryKey } from '../../data/pool-entries'
import {
  buildDrawnEvent,
  buildEvent,
  buildFixture,
  buildPool,
  buildTenPools,
  TEN_POOLS_BY_ID,
  TEN_POOLS_BY_POSITION,
} from '../../data/seed.factory'
import { poolsSectionPage } from './pools-section.page'

/** An event with a **cut draw** and exactly one pool — so the card-scoped queries
 * (`getTableToggle`, `getNameInput`) address one card rather than throwing on two.
 * A single fixture is a draw: the freeze turns on the draw *existing*, not on its
 * size (ADR-0786). */
const drawnOnePoolEvent = () =>
  buildEvent({
    pools: [buildPool()],
    fixtures: [buildFixture({ poolId: 'p-1' })],
  })

/** A morning pool and an afternoon pool — what a viewer actually reads. */
const twoPools = () => [
  buildPool({
    id: 'p-1',
    name: 'Pool A',
    slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
    tableIds: ['t1', 't2'],
    position: 0,
  }),
  buildPool({
    id: 'p-2',
    name: 'Pool B',
    slot: { date: '2026-06-13', start: '13:00', end: '17:00' },
    tableIds: ['t3'],
    position: 1,
  }),
]

/** Two *overlapping* pools sharing table t1 — a double-booking, the state that
 * raises the conflict Alert. */
const conflictingPools = () => [
  buildPool({
    id: 'a',
    name: 'Pool A',
    slot: { date: '2026-06-13', start: '09:00', end: '12:00' },
    tableIds: ['t1'],
    position: 0,
  }),
  buildPool({
    id: 'b',
    name: 'Pool B',
    slot: { date: '2026-06-13', start: '11:00', end: '14:00' },
    tableIds: ['t1'],
    position: 1,
  }),
]

describe('PoolsSection', () => {
  // The three mutations, each asserted against the live form state the section
  // now drives via `useFieldArray` (chore 1e) — not a bridged `onChange` spy.
  describe('the pool list drives the form', () => {
    it('appends a pool to the form when Add pool is clicked', async () => {
      poolsSectionPage.render({ event: buildEvent({ pools: [buildPool()] }) })
      await userEvent.click(poolsSectionPage.getAddPoolButton())
      expect(poolsSectionPage.getPools()).toHaveLength(2)
    })

    it('writes an edited table selection into the form', async () => {
      // The seeded pool reserves t1–t4; toggling T5 must land in form state.
      poolsSectionPage.render({
        event: buildEvent({ pools: [buildPool({ tableIds: ['t1'] })] }),
      })

      await userEvent.click(poolsSectionPage.getTableToggle('T5'))
      expect(poolsSectionPage.getPools()[0].tableIds).toEqual(['t1', 't5'])
    })

    it('removes a pool from the form', async () => {
      poolsSectionPage.render({ event: buildEvent({ pools: twoPools() }) })
      expect(poolsSectionPage.getPools()).toHaveLength(2)

      // Remove the first pool; the second must be what survives.
      await userEvent.click(poolsSectionPage.getRemovePoolButtons()[0])
      const remaining = poolsSectionPage.getPools()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).toMatchObject({ kind: 'kept', id: 'p-2' })
    })
  })

  /**
   * **Ten pools read 1 … 10** — the claim `Pool.position` was added to make.
   *
   * The fixture (`buildTenPools`) hands the section its pools in the order a sort by ID
   * would produce, because a sorted fixture cannot falsify anything: it would pass just
   * as happily against a section that trusted the array it was given, and against one
   * that sorted by id. Here both of those render `Pool 1, Pool 10, Pool 2 …`, which is
   * the real ten-pool bug, spelled out in the guard below.
   */
  describe('ten pools, in position order', () => {
    // The fixture's own shape, asserted rather than assumed — if this ever stops being
    // the id order, every claim below quietly stops discriminating.
    it('is built from a fixture whose id order is the WRONG order', () => {
      expect(TEN_POOLS_BY_ID).toEqual([
        'Pool 1',
        'Pool 10',
        'Pool 2',
        'Pool 3',
        'Pool 4',
        'Pool 5',
        'Pool 6',
        'Pool 7',
        'Pool 8',
        'Pool 9',
      ])
      expect(TEN_POOLS_BY_ID).not.toEqual(TEN_POOLS_BY_POSITION)
    })

    it('renders the cards in position order, not in id order', () => {
      poolsSectionPage.render({ event: buildEvent({ pools: buildTenPools() }) })

      expect(poolsSectionPage.getPoolNames()).toEqual(TEN_POOLS_BY_POSITION)
    })

    // …and the same for a reader, whose cards are text rather than boxes (ADR-0015).
    it('reads back in position order for a viewer too', () => {
      poolsSectionPage.render({
        event: buildEvent({ pools: buildTenPools() }),
        canEdit: false,
      })

      expect(poolsSectionPage.getPoolNames()).toEqual(TEN_POOLS_BY_POSITION)
    })

    /**
     * The order the cards are in is the order the FORM is in — which matters because the
     * form array is what a save serializes, and the server re-derives each position from
     * that array's index. A section that sorted only its render would round-trip the
     * director's pools into a different order than the one they were looking at.
     */
    it('seeds the form array in position order, so the save sends that order', () => {
      poolsSectionPage.render({ event: buildEvent({ pools: buildTenPools() }) })

      expect(poolsSectionPage.getPools().map((p) => p.name)).toEqual(
        TEN_POOLS_BY_POSITION,
      )
      // …and every one of them CITES the id the server minted (ADR 20260801). An entry
      // that arrived as an `added` would be an insert, and the pool it stopped citing a
      // removal — a no-op edit that silently replaced ten pools with ten new ones and
      // took the draw dealt across them with it.
      expect(poolsSectionPage.getPools().map((p) => p.kind)).toEqual(
        Array(10).fill('kept'),
      )
      expect(poolsSectionPage.getPools().map((p) => poolEntryKey(p))).toEqual(
        buildTenPools()
          .sort((a, b) => a.position - b.position)
          .map((p) => p.id),
      )
    })

    /**
     * **The order is now the only thing that says where a pool sits**, so a pool added
     * at the end has to *be* at the end: the server derives each position from the index
     * of the entry in the list it is sent (`PoolWrite` has no `position` — sending one is
     * a 422 naming the field), and the array the editor serializes is this one.
     *
     * Ten pools, so "last" cannot be confused with anything else, and the removal case
     * below is the one the old client-side position arithmetic got wrong.
     */
    it('appends an added pool at the END, with no id and no position', async () => {
      poolsSectionPage.render({ event: buildEvent({ pools: buildTenPools() }) })

      await userEvent.click(poolsSectionPage.getAddPoolButton())

      const pools = poolsSectionPage.getPools()
      expect(pools).toHaveLength(11)
      expect(pools.at(-1)?.kind).toBe('added')
      // Structurally impossible to hold an id, and asserted on the JSON anyway: this is
      // the claim the whole chore is about, and a key that came back as `undefined`
      // would satisfy a value assertion while still being a key on the wire.
      expect(pools.at(-1) && 'id' in pools.at(-1)!).toBe(false)
      expect(pools.at(-1) && 'position' in pools.at(-1)!).toBe(false)
      // The ten it joined are untouched — same ids, same order.
      expect(pools.slice(0, 10).map((p) => p.kind)).toEqual(Array(10).fill('kept'))
    })

    /**
     * Remove a pool from the MIDDLE, then add one. This is where the client's own
     * position arithmetic used to matter (ten pools minus one is nine, so a
     * count-derived position would have handed the newcomer a `9` that pool 10 already
     * held) — and where it now matters that there is none: what is sent is nine cited
     * pools in their director-chosen order, then one id-less entry, and the server reads
     * the positions off that.
     */
    it('keeps the surviving pools cited, in order, with the newcomer last', async () => {
      poolsSectionPage.render({ event: buildEvent({ pools: buildTenPools() }) })

      // The third card is Pool 3 (position 2).
      await userEvent.click(poolsSectionPage.getRemovePoolButtons()[2])
      await userEvent.click(poolsSectionPage.getAddPoolButton())

      const pools = poolsSectionPage.getPools()
      expect(pools.map((p) => p.name)).toEqual([
        'Pool 1',
        'Pool 2',
        'Pool 4',
        'Pool 5',
        'Pool 6',
        'Pool 7',
        'Pool 8',
        'Pool 9',
        'Pool 10',
        // Nine pools were left, so the default name is the tenth letter — the naming and
        // the diff are independent, and only the diff is load-bearing.
        'Pool J',
      ])
      expect(pools.map((p) => p.kind)).toEqual([
        ...Array(9).fill('kept'),
        'added',
      ])
      // Pool 3 is simply gone from the payload — an uncited stored pool is what a
      // removal IS on the wire (ADR 20260801), never a flag or a tombstone.
      expect(pools.map((p) => p.name)).not.toContain('Pool 3')
    })
  })

  /**
   * The two things a pools save must get right about identity, asserted on the form
   * state the save serializes.
   *
   * They are opposite failures and both are silent: an added pool that carried an id
   * would be a 422 (`extra_forbidden` on `body.pools[i].id`) or — before the ids moved
   * server-side — a duplicate, and a stored pool that lost one would be read as a
   * removal, taking every fixture dealt into it.
   */
  describe('who owns a pool id', () => {
    it('adds a pool with NO id — the server mints it', async () => {
      poolsSectionPage.render({ event: buildEvent({ pools: [buildPool()] }) })

      await userEvent.click(poolsSectionPage.getAddPoolButton())

      const [kept, added] = poolsSectionPage.getPools()
      expect(kept).toMatchObject({ kind: 'kept', id: 'p-1' })
      expect(added.kind).toBe('added')
      expect('id' in added).toBe(false)
    })

    // …and the other half: editing a stored pool re-words it, it does not re-create it.
    // Every field the card can touch is exercised, because the card hands its whole draft
    // back through one `onChange` — a mapper that rebuilt the entry from that draft would
    // drop the id on the FIRST keystroke, whichever box it was in.
    it('keeps a stored pool’s id through a rename, a re-window and a re-table', async () => {
      poolsSectionPage.render({ event: buildEvent({ pools: [buildPool()] }) })

      fireEvent.change(poolsSectionPage.getNameInput(), {
        target: { value: 'Morning Pool' },
      })
      fireEvent.change(screen.getByLabelText('Start'), {
        target: { value: '10:30' },
      })
      await userEvent.click(poolsSectionPage.getTableToggle('T9'))

      expect(poolsSectionPage.getPools()).toEqual([
        {
          kind: 'kept',
          id: 'p-1',
          name: 'Morning Pool',
          slot: { date: '2026-06-13', start: '10:30', end: '12:30' },
          tableIds: ['t1', 't2', 't3', 't4', 't9'],
        },
      ])
    })

    /** A card is handed a `PoolDraft` — three fields — so the arm and the id are not
     * values it can reach, let alone change. Proved by editing an ADDED pool, the case
     * where a leaked identity would be a client-authored id: it stays id-less. */
    it('cannot promote an added pool into a kept one by editing it', async () => {
      // An event with no pools yet, so the one card on screen after the click is the
      // added one and the card-scoped name box addresses it. (`getAddPoolButton` matches
      // both the header's button and the empty state's, so the empty state's is named.)
      poolsSectionPage.render({ event: buildEvent({ pools: [] }) })

      await userEvent.click(
        screen.getByRole('button', { name: 'Add first pool' }),
      )
      fireEvent.change(poolsSectionPage.getNameInput(), {
        target: { value: 'Pool Zero' },
      })

      const [added] = poolsSectionPage.getPools()
      expect(added).toMatchObject({ kind: 'added', name: 'Pool Zero' })
      expect('id' in added).toBe(false)
    })
  })

  it('counts distinct double-booked tables, not conflict pairs', () => {
    // One table (t1) shared across three mutually-overlapping pools yields
    // three conflict pairs but is still a single double-booked table.
    poolsSectionPage.render({
      event: buildEvent({
        pools: [
          buildPool({ id: 'a', name: 'A', slot: { date: '2026-06-13', start: '09:00', end: '12:00' }, tableIds: ['t1'], position: 0 }),
          buildPool({ id: 'b', name: 'B', slot: { date: '2026-06-13', start: '10:00', end: '13:00' }, tableIds: ['t1'], position: 1 }),
          buildPool({ id: 'c', name: 'C', slot: { date: '2026-06-13', start: '11:00', end: '14:00' }, tableIds: ['t1'], position: 2 }),
        ],
      }),
    })
    const alert = poolsSectionPage.queryConflictAlert()
    expect(alert).toHaveTextContent('1 table is double-booked')
    expect(alert).not.toHaveTextContent('3 tables are')
  })

  it('warns when two overlapping pools share a table', () => {
    poolsSectionPage.render({
      event: buildEvent({ pools: conflictingPools() }),
    })
    expect(poolsSectionPage.queryConflictAlert()).toHaveTextContent('double-booked')
  })

  it('shows the empty state with no pools', () => {
    poolsSectionPage.render({ event: buildEvent({ pools: [] }) })
    expect(poolsSectionPage.queryPoolCards()).toHaveLength(0)
    expect(document.body).toHaveTextContent('No pools yet')
  })

  // ADR-0786's pool-set freeze, in the editor. The pools of an event whose draw is CUT
  // may no longer be added to or removed from — a fixture names its pool by id — but
  // everything else about a pool stays editable, because venues move under a running
  // tournament. Both halves are asserted, and the second half is the one that matters:
  // a section that greyed itself out wholesale would pass the first three tests here and
  // break the very case the freeze exists to permit.
  describe('once the draw is cut', () => {
    it('disables Add pool and names the draw as the reason, with the way out', () => {
      poolsSectionPage.render({ event: buildDrawnEvent() })

      expect(poolsSectionPage.getAddPoolButton()).toBeDisabled()
      const notice = poolsSectionPage.queryFrozenNotice()
      expect(notice).toHaveTextContent('This event’s draw is cut')
      // The way out, not merely the refusal: a director who is only told "no" is stuck.
      expect(notice).toHaveTextContent('Delete the draw')
      expect(notice).toHaveTextContent('cut it again')
    })

    it('disables every Remove pool button, pointing it at that reason', () => {
      poolsSectionPage.render({ event: buildDrawnEvent() })

      // Both cards — the second is where a "disable the first one" fix would show.
      const removeButtons = poolsSectionPage.getRemovePoolButtons()
      expect(removeButtons).toHaveLength(2)
      for (const button of removeButtons) expect(button).toBeDisabled()

      // A disabled button holds no tooltip a screen reader will read, so the reason is
      // in text — and the button says where.
      const notice = poolsSectionPage.queryFrozenNotice()
      expect(removeButtons[0]).toHaveAttribute('aria-describedby', notice?.id)
    })

    // ⚠️ THE DISCRIMINATING ONE. Only the pool *identity set* is frozen: a table that
    // breaks mid-event is pulled from its pool, the pool slips an hour, a pool is
    // renamed — all with the draw standing, and none of it costing the director their
    // placements (CONTEXT.md, "Pool"; `_enforce_pool_set_frozen`). Asserted by *doing*
    // each edit and reading the form state back, not by `toBeEnabled()`: a control can
    // be enabled and still wired to nothing.
    //
    // One pool, so the card-scoped queries address exactly one card (the section-level
    // ones throw on two). It is still a cut draw — one fixture is a draw.
    it('leaves a pool’s tables, window and name editable', async () => {
      poolsSectionPage.render({ event: drawnOnePoolEvent() })

      // The table a director pulls when it breaks (the pool holds t1–t4).
      await userEvent.click(poolsSectionPage.getSelectedTableToggle('T1'))
      expect(poolsSectionPage.getPools()[0].tableIds).not.toContain('t1')

      // …and the one that frees up.
      await userEvent.click(poolsSectionPage.getTableToggle('T9'))
      expect(poolsSectionPage.getPools()[0].tableIds).toContain('t9')

      // The window slips an hour and a half.
      fireEvent.change(screen.getByLabelText('Start'), {
        target: { value: '10:30' },
      })
      expect(poolsSectionPage.getPools()[0].slot.start).toBe('10:30')

      // And the display name is only a display name — identity lives in the `id`, which
      // no control here can touch, so every fixture still resolves. (The card is handed
      // three fields and the id is not one of them, which is what makes that structural
      // rather than merely true today.)
      fireEvent.change(poolsSectionPage.getNameInput(), {
        target: { value: 'Morning Pool' },
      })
      const [pool] = poolsSectionPage.getPools()
      expect(pool.name).toBe('Morning Pool')
      expect(pool).toMatchObject({ kind: 'kept', id: 'p-1' })

      // None of which added or removed a pool.
      expect(poolsSectionPage.getPools()).toHaveLength(1)
    })

    // The whole freeze turns on the draw existing. With none cut, the section is exactly
    // what it always was — no dead buttons, and nothing to explain.
    it('is not frozen when no draw is cut', () => {
      poolsSectionPage.render({ event: buildEvent({ pools: twoPools() }) })

      expect(poolsSectionPage.getAddPoolButton()).toBeEnabled()
      for (const button of poolsSectionPage.getRemovePoolButtons()) {
        expect(button).toBeEnabled()
      }
      expect(poolsSectionPage.queryFrozenNotice()).toBeNull()
    })

    // A viewer has no add/remove affordance to explain and no draw to delete: the notice
    // would be an instruction they cannot follow, about buttons they cannot see.
    it('shows a non-owner no freeze notice', () => {
      poolsSectionPage.render({ event: buildDrawnEvent(), canEdit: false })

      expect(poolsSectionPage.queryFrozenNotice()).toBeNull()
      expect(poolsSectionPage.getFormElements()).toHaveLength(0)
    })
  })

  /**
   * A pool is *called* something, and the server now says so (`Pool.name`,
   * `min_length=1`). The section does not *decide* that — the editor's resolver does,
   * and it is what refuses the save — but the section is where the verdict has to land:
   * under the box that is empty, on the card it is about.
   */
  describe('a pool with no name', () => {
    it('reds the named pool’s card and no other', () => {
      poolsSectionPage.render({
        event: buildEvent({ pools: twoPools() }),
        nameIssues: { 'p-2': 'Name is required.' },
      })

      const [poolA, poolB] = poolsSectionPage.getPoolNameInputs()
      expect(poolsSectionPage.getPoolNameErrors()).toEqual(['Name is required.'])
      expect(poolB).toHaveAttribute('aria-invalid', 'true')
      expect(poolA).not.toHaveAttribute('aria-invalid', 'true')
    })

    // Keyed by pool ID, not by index: a director who removes the first of three pools
    // renumbers every card, and an index-keyed message would then be red under the
    // wrong box.
    it('follows the pool it belongs to when a card above it is removed', async () => {
      poolsSectionPage.render({
        event: buildEvent({ pools: twoPools() }),
        nameIssues: { 'p-2': 'Name is required.' },
      })

      await userEvent.click(poolsSectionPage.getRemovePoolButtons()[0])

      // One card left — Pool B, the blank one — and the red is still under it.
      expect(poolsSectionPage.queryPoolCards()).toHaveLength(1)
      expect(poolsSectionPage.getPoolNameErrors()).toEqual(['Name is required.'])
      expect(poolsSectionPage.getPoolNameInputs()[0]).toHaveAttribute(
        'aria-invalid',
        'true',
      )
    })

    it('says nothing in red when the editor hands it no issues', () => {
      poolsSectionPage.render({ event: buildEvent({ pools: twoPools() }) })
      expect(poolsSectionPage.getPoolNameErrors()).toEqual([])
    })
  })

  describe('for a non-owner (read-only)', () => {
    // The guard test (ADR 0015, rule 6). Rendered *with* pools on purpose: an
    // event with none has nothing but the Add button, so a sweep over the empty
    // state would never touch a pool card's date/time inputs or its wall of
    // table toggles — precisely the controls most likely to be left live.
    it('renders no interactive controls', () => {
      poolsSectionPage.render({
        event: buildEvent({ pools: twoPools() }),
        canEdit: false,
      })
      // The DOM sweep first: it is the load-bearing one, so it is the one whose
      // red is worth seeing.
      expect(poolsSectionPage.getFormElements()).toHaveLength(0)
      expect(poolsSectionPage.getInteractiveControls()).toHaveLength(0)
    })

    // The per-table toggles are gone, not disabled — a viewer reads the tables
    // a pool reserves, they do not un-reserve one.
    it('renders no per-table toggles', () => {
      poolsSectionPage.render({
        event: buildEvent({ pools: twoPools() }),
        canEdit: false,
      })
      expect(screen.queryByRole('button', { name: 'T1' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'T12' })).toBeNull()
    })

    it('reads each pool as its name, its window and its tables', () => {
      poolsSectionPage.render({
        event: buildEvent({ pools: twoPools() }),
        canEdit: false,
      })

      const [first, second] = poolsSectionPage.queryPoolCards()
      expect(first).toHaveTextContent('Pool A')
      // In words, not the `YYYY-MM-DD` the editor's date input takes.
      expect(first).toHaveTextContent('Jun 13, 2026')
      expect(first).toHaveTextContent('09:00')
      expect(first).toHaveTextContent('12:30')
      expect(first).toHaveTextContent('T1, T2')
      expect(second).toHaveTextContent('Pool B')
      expect(second).toHaveTextContent('T3')
    })

    // A double-booking is a flaw in the organizer's configuration and only they
    // can fix it. Shown to a reader it is an unactionable warning about someone
    // else's tournament. The owner's Alert is proved above ("warns when two
    // overlapping pools share a table") off the same fixture, so this cannot be
    // satisfied by deleting the Alert outright.
    it('hides the double-booking warning', () => {
      poolsSectionPage.render({
        event: buildEvent({ pools: conflictingPools() }),
        canEdit: false,
      })
      expect(poolsSectionPage.queryConflictAlert()).toBeNull()
      expect(document.body).not.toHaveTextContent('double-booked')
      // The pools themselves still read back — it is the diagnostic that goes,
      // not the data.
      expect(poolsSectionPage.queryPoolCards()).toHaveLength(2)
    })

    // Hidden, never disabled: a disabled button is an unexplained dead end.
    it('hides the Add pool and Remove pool buttons', () => {
      poolsSectionPage.render({
        event: buildEvent({ pools: twoPools() }),
        canEdit: false,
      })
      expect(poolsSectionPage.queryAddPoolButton()).toBeNull()
      expect(screen.queryByRole('button', { name: 'Remove pool' })).toBeNull()
    })

    // "No pools yet" / "Add a pool to…" is the organizer's to-do list. A viewer
    // is being told a fact about the event, and is offered nothing to add.
    it('states that no tables are reserved, with no Add button', () => {
      poolsSectionPage.render({
        event: buildEvent({ pools: [] }),
        canEdit: false,
      })
      expect(screen.getByText('No table pools')).toBeInTheDocument()
      expect(
        screen.getByText('No tables are reserved for this event.'),
      ).toBeInTheDocument()
      expect(document.body).not.toHaveTextContent('No pools yet')
      expect(poolsSectionPage.queryAddPoolButton()).toBeNull()
      expect(poolsSectionPage.getFormElements()).toHaveLength(0)
    })
  })
})
