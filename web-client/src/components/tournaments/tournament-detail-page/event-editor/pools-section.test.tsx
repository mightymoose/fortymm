import userEvent from '@testing-library/user-event'

import { screen } from '@/test/utilities'

import { buildEvent, buildPool } from '../../data/seed.factory'
import { poolsSectionPage } from './pools-section.page'

/** A morning pool and an afternoon pool — what a viewer actually reads. */
const twoPools = () => [
  buildPool({
    id: 'p-1',
    name: 'Pool A',
    slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
    tableIds: ['t1', 't2'],
  }),
  buildPool({
    id: 'p-2',
    name: 'Pool B',
    slot: { date: '2026-06-13', start: '13:00', end: '17:00' },
    tableIds: ['t3'],
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
  }),
  buildPool({
    id: 'b',
    name: 'Pool B',
    slot: { date: '2026-06-13', start: '11:00', end: '14:00' },
    tableIds: ['t1'],
  }),
]

describe('PoolsSection', () => {
  it('appends a pool when Add pool is clicked', async () => {
    const onChange = vi.fn()
    poolsSectionPage.render({ event: buildEvent({ pools: [buildPool()] }), onChange })
    await userEvent.click(poolsSectionPage.getAddPoolButton())
    expect(onChange.mock.calls.at(-1)?.[0].pools).toHaveLength(2)
  })

  it('counts distinct double-booked tables, not conflict pairs', () => {
    // One table (t1) shared across three mutually-overlapping pools yields
    // three conflict pairs but is still a single double-booked table.
    poolsSectionPage.render({
      event: buildEvent({
        pools: [
          buildPool({ id: 'a', name: 'A', slot: { date: '2026-06-13', start: '09:00', end: '12:00' }, tableIds: ['t1'] }),
          buildPool({ id: 'b', name: 'B', slot: { date: '2026-06-13', start: '10:00', end: '13:00' }, tableIds: ['t1'] }),
          buildPool({ id: 'c', name: 'C', slot: { date: '2026-06-13', start: '11:00', end: '14:00' }, tableIds: ['t1'] }),
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
