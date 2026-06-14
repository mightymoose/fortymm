import userEvent from '@testing-library/user-event'

import { buildEvent, buildPool } from '../../data/seed.factory'
import { poolsSectionPage } from './pools-section.page'

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
      event: buildEvent({
        pools: [
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
        ],
      }),
    })
    expect(poolsSectionPage.queryConflictAlert()).toHaveTextContent('double-booked')
  })

  it('shows the empty state with no pools', () => {
    poolsSectionPage.render({ event: buildEvent({ pools: [] }) })
    expect(poolsSectionPage.queryPoolCards()).toHaveLength(0)
    expect(document.body).toHaveTextContent('No pools yet')
  })
})
