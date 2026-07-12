import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'

import { ApiError } from '@/api/client'
import { mockTournamentTransitionEndpoint } from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentDetailRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { waitFor } from '@/test/utilities'

import { buildEvent, buildTournament } from './data/seed.factory'
import { tournamentDetailPagePage } from './tournament-detail-page.page'

describe('TournamentDetailPage', () => {
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
    // A successful create closes the editor — and it is the ONLY thing that does.
    await waitFor(() => expect(tournamentDetailPagePage.queryEditor()).toBeNull())
  })

  // The page's half of the data-loss bug: it used to fire the mutation and close
  // the editor in the same breath, so a 422 landed on a sheet that was already gone
  // and took every field the organizer had typed with it. The write is awaited now,
  // and only a RESOLVED one closes anything.
  it('keeps the event editor open when the create is REFUSED', async () => {
    const onCreateEvent = vi
      .fn()
      .mockRejectedValue(new ApiError(422, 'Name is too long.', 'create event'))
    tournamentDetailPagePage.render({
      tournament: buildTournament({ events: [] }),
      onCreateEvent,
    })

    await userEvent.click(tournamentDetailPagePage.getNewEventButton())
    await userEvent.click(tournamentDetailPagePage.getEditorSaveButton())

    await waitFor(() =>
      expect(tournamentDetailPagePage.queryEditorFailure()).toBeInTheDocument(),
    )
    expect(tournamentDetailPagePage.queryEditorFailure()).toHaveTextContent(
      'Name is too long.',
    )
    expect(tournamentDetailPagePage.queryEditor()).toBeInTheDocument()
  })

  it('hides the lifecycle action for a non-creator', () => {
    tournamentDetailPagePage.render({
      tournament: buildTournament({ status: 'draft', canEdit: false }),
    })
    expect(
      tournamentDetailPagePage.queryLifecycleButton(/Publish/),
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
