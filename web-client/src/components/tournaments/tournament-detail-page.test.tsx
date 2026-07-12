import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'

import { mockTournamentTransitionEndpoint } from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentDetailRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { waitFor } from '@/test/utilities'

import { buildAddress, buildEvent, buildTournament } from './data/seed.factory'
import { tournamentDetailPagePage } from './tournament-detail-page.page'

describe('TournamentDetailPage', () => {
  // Same doctrine as the card's: the separators are joins between the address
  // parts that are present, so a partial address strands no punctuation and an
  // empty one renders no meta item at all (#994, #972).
  describe('the header venue line', () => {
    it('joins the address parts that are present', () => {
      tournamentDetailPagePage.render({ tournament: buildTournament() })

      expect(tournamentDetailPagePage.queryVenueLine()).toHaveTextContent(
        'Berkeley TT Club · Berkeley, CA',
      )
    })

    it('drops the comma the missing region would have hung off', () => {
      tournamentDetailPagePage.render({
        tournament: buildTournament({ address: buildAddress({ region: '' }) }),
      })

      const line = tournamentDetailPagePage.queryVenueLine()
      expect(line).toHaveTextContent('Berkeley TT Club · Berkeley')
      expect(line?.textContent).not.toContain(',')
    })

    it('renders no venue meta item — pin included — when there is no address', () => {
      tournamentDetailPagePage.render({
        tournament: buildTournament({
          address: buildAddress({ venue: '', city: '', region: '' }),
        }),
      })

      // Absent, not blank: the item carries the pin and the punctuation, so a
      // rendered-but-empty one would still read as the bug's bare "· ,". (The
      // interpunct legitimately appears elsewhere on the page — the event card's
      // own meta — so this asserts the item, not the character.)
      expect(tournamentDetailPagePage.queryVenueLine()).toBeNull()
    })
  })

  // A database identifier is not user-facing copy: the header used to print the
  // tournament's raw UUID in a `#` chip (#972). It is gone, not relabelled.
  it('never shows the tournament\'s raw id', () => {
    tournamentDetailPagePage.render({
      tournament: buildTournament({ id: '8330f9f7-c64c-4f9d-910d-56b77bde88cb' }),
    })

    expect(document.body).not.toHaveTextContent(
      '8330f9f7-c64c-4f9d-910d-56b77bde88cb',
    )
  })

  // The stat strip prints its own unit, so it owns the plural. Both sides are
  // asserted: a fix that simply hardcoded "day" would read "2 day" for a
  // weekend tournament, which is the same bug wearing the other shoe.
  describe('the Days stat', () => {
    it('reads "day" for a one-day tournament', () => {
      tournamentDetailPagePage.render({
        tournament: buildTournament({
          startDate: '2026-08-22',
          endDate: '2026-08-22',
          events: [],
        }),
      })
      expect(tournamentDetailPagePage.getDaysStat()).toBe('1day')
    })

    it('reads "days" for a multi-day tournament', () => {
      tournamentDetailPagePage.render({
        tournament: buildTournament({
          startDate: '2026-08-22',
          endDate: '2026-08-23',
          events: [],
        }),
      })
      expect(tournamentDetailPagePage.getDaysStat()).toBe('2days')
    })
  })

  it('shows the lifecycle action matching the status', () => {
    tournamentDetailPagePage.render({
      tournament: buildTournament({ status: 'draft' }),
    })
    expect(
      tournamentDetailPagePage.getLifecycleButton(/Publish/),
    ).toBeInTheDocument()
    expect(
      tournamentDetailPagePage.queryLifecycleButton(/Start tournament/),
    ).toBeNull()
  })

  // Publish is a REQUEST, and this asserts the request. The predecessor asserted
  // the `onUpdate` prop spy instead — and stayed green through the whole window in
  // which Publish did nothing at all: `status` had left `TournamentUpdate`, so the
  // patch it built silently dropped it. A prop spy proves the component called its
  // prop; it cannot tell a working button from an inert one. Watch the wire.
  it('publishes a draft tournament through the transitions endpoint', async () => {
    const seen: { url: string; body: unknown }[] = []
    mockTournamentTransitionEndpoint(server, async ({ request }) => {
      seen.push({ url: request.url, body: await request.json() })
      const { events, ...read } = buildTournamentDetailRead()
      void events
      return HttpResponse.json(read, { status: 201 })
    })
    const onUpdate = vi.fn()
    tournamentDetailPagePage.render({
      tournament: buildTournament({ id: 't-1', status: 'draft' }),
      onUpdate,
    })

    await userEvent.click(tournamentDetailPagePage.getLifecycleButton(/Publish/))

    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].url).toContain('/v1/tournaments/t-1/transitions')
    expect(seen[0].body).toEqual({ to: 'published' })
    // …and NOT through the tournament PATCH: `onUpdate` writes the tournament's
    // fields, and carries no status (ADR-0017).
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('opens the event editor and creates a new event', async () => {
    const onCreateEvent = vi.fn()
    tournamentDetailPagePage.render({
      tournament: buildTournament({ events: [] }),
      onCreateEvent,
    })

    await userEvent.click(tournamentDetailPagePage.getNewEventButton())
    await userEvent.click(tournamentDetailPagePage.getEditorSaveButton())
    expect(onCreateEvent).toHaveBeenCalledTimes(1)
  })

  // `published`, not `draft`: a non-creator can no longer be looking at a draft at
  // all — the API hides an unannounced tournament from everyone but its creator, so
  // it answers a stranger's GET with a 404 (#967) and this page never renders. A
  // non-owner + `draft` fixture would be a state the server cannot produce, and the
  // test would prove nothing about the world. `published` is the reachable case: I
  // can see other people's announced tournaments, and I still get no button.
  //
  // The button asserted absent is the one the OWNER of a `published` tournament is
  // offered ("Start tournament"). Asserting `/Publish/` here would pass on a
  // published tournament even if the gate were removed entirely — nobody, owner or
  // not, is offered Publish from `published`.
  it('hides the lifecycle action for a non-creator', () => {
    tournamentDetailPagePage.render({
      tournament: buildTournament({ status: 'published', canEdit: false }),
    })
    expect(
      tournamentDetailPagePage.queryLifecycleButton(/Start tournament/),
    ).toBeNull()
  })

  it('hides the "new event" affordance for a non-creator', () => {
    tournamentDetailPagePage.render({
      tournament: buildTournament({ events: [buildEvent()], canEdit: false }),
    })
    expect(tournamentDetailPagePage.queryNewEventButtons()).toHaveLength(0)
  })

  it('navigates back via the breadcrumb', async () => {
    const onBack = vi.fn()
    tournamentDetailPagePage.render({
      tournament: buildTournament({ events: [buildEvent()] }),
      onBack,
    })
    await userEvent.click(tournamentDetailPagePage.getBackCrumb())
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
