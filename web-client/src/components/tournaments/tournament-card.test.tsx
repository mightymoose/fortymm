import userEvent from '@testing-library/user-event'

import {
  buildAddress,
  buildEntrants,
  buildTournament,
  buildEvent,
} from './data/seed.factory'
import { tournamentCardPage } from './tournament-card.page'

describe('TournamentCard', () => {
  it('shows the name, venue, and derived stats', () => {
    tournamentCardPage.render({
      tournament: buildTournament({
        name: 'Bay Area Open 2026',
        tableIds: ['t1', 't2', 't3'],
        // The entry count is derived from the entrants, so the fixture states
        // the entrants and the count follows — there is no second copy to skew.
        events: [
          buildEvent({ id: 'a', entrants: buildEntrants(52) }),
          buildEvent({ id: 'b', entrants: buildEntrants(22) }),
        ],
      }),
    })

    expect(tournamentCardPage.getOpenButton('Bay Area Open 2026')).toBeInTheDocument()
    expect(tournamentCardPage.getBadge()).toHaveTextContent('Published')
    // 52 + 22 entries; 2 events; 3 tables.
    expect(document.body).toHaveTextContent('74')
    expect(tournamentCardPage.queryVenueLine()).toHaveTextContent(
      'Berkeley TT Club · Berkeley, CA',
    )
  })

  // The address parts are all optional, and the separators are joins between
  // the parts that are there — never literals in a template. The template form
  // printed a bare "· ," for a venue-less tournament (#994).
  describe('the venue line', () => {
    it('drops the separators the missing parts would have hung off', () => {
      tournamentCardPage.render({
        tournament: buildTournament({
          address: buildAddress({ city: '', region: '' }),
        }),
      })

      const line = tournamentCardPage.queryVenueLine()
      expect(line).toHaveTextContent('Berkeley TT Club')
      expect(line?.textContent).not.toContain('·')
      expect(line?.textContent).not.toContain(',')
    })

    it('renders no venue line at all — pin included — when there is no address', () => {
      tournamentCardPage.render({
        tournament: buildTournament({
          name: 'GAMMA-UNANNOUNCED',
          address: buildAddress({ venue: '', city: '', region: '' }),
        }),
      })

      expect(tournamentCardPage.queryVenueLine()).toBeNull()
      // Not "a bare · , " — the card is left with no punctuation to strand.
      expect(document.body).not.toHaveTextContent('·')
    })
  })

  // The distance is `null`/absent unless the list query carried a location, so
  // the card shows a badge only when it's a number — and never a "— mi" hole.
  describe('the distance badge', () => {
    it('shows the formatted distance when the tournament carries one', () => {
      tournamentCardPage.render({
        tournament: buildTournament({ distanceMiles: 12 }),
      })

      expect(tournamentCardPage.queryDistanceBadge()).toHaveTextContent('12 mi')
    })

    it('renders a sub-mile distance cleanly, without re-rounding to zero', () => {
      tournamentCardPage.render({
        tournament: buildTournament({ distanceMiles: 0.4 }),
      })

      expect(tournamentCardPage.queryDistanceBadge()).toHaveTextContent('0.4 mi')
    })

    it('renders no badge when the tournament carries no distance', () => {
      tournamentCardPage.render({
        tournament: buildTournament({ distanceMiles: null }),
      })

      expect(tournamentCardPage.queryDistanceBadge()).toBeNull()
    })

    it('renders no badge when distance is absent from the payload', () => {
      // The default seed sets no `distanceMiles` at all (a seed/draft tournament,
      // or the default un-located list) — the badge element must not exist.
      tournamentCardPage.render({ tournament: buildTournament() })

      expect(tournamentCardPage.queryDistanceBadge()).toBeNull()
    })
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
