import userEvent from '@testing-library/user-event'

import { buildTournament, buildEvent } from './data/seed.factory'
import { tournamentCardPage } from './tournament-card.page'

describe('TournamentCard', () => {
  it('shows the name, venue, and derived stats', () => {
    tournamentCardPage.render({
      tournament: buildTournament({
        name: 'Bay Area Open 2026',
        tableIds: ['t1', 't2', 't3'],
        events: [
          buildEvent({ id: 'a', entered: 52 }),
          buildEvent({ id: 'b', entered: 22 }),
        ],
      }),
    })

    expect(tournamentCardPage.getOpenButton('Bay Area Open 2026')).toBeInTheDocument()
    expect(tournamentCardPage.getBadge()).toHaveTextContent('Published')
    // 52 + 22 entries; 2 events; 3 tables.
    expect(document.body).toHaveTextContent('74')
    expect(document.body).toHaveTextContent('Berkeley TT Club')
  })

  it('opens the tournament when the card is clicked', async () => {
    const onOpen = vi.fn()
    tournamentCardPage.render({
      tournament: buildTournament({ name: 'Summer Slam' }),
      onOpen,
    })

    await userEvent.click(tournamentCardPage.getOpenButton('Summer Slam'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('deletes via the dedicated delete control', async () => {
    const onDelete = vi.fn()
    tournamentCardPage.render({
      tournament: buildTournament({ name: 'Summer Slam' }),
      onDelete,
    })

    await userEvent.click(tournamentCardPage.getDeleteButton('Summer Slam'))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('hides the delete control for a non-creator (canEdit: false)', () => {
    tournamentCardPage.render({
      tournament: buildTournament({ name: 'Summer Slam', canEdit: false }),
    })

    expect(tournamentCardPage.getOpenButton('Summer Slam')).toBeInTheDocument()
    expect(tournamentCardPage.queryDeleteButton('Summer Slam')).toBeNull()
  })
})
