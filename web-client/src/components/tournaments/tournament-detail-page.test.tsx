import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'

import { ApiError } from '@/api/client'
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

  /**
   * The go-live precondition, on the page the director is actually looking at (ADR-0786).
   *
   * Two claims, and the second is the one only a page-level test can make: the refusal
   * reaches the director **with the offending event named**, and the page goes on
   * telling the truth about where the tournament stands — the pill still reads
   * **Published**, because nothing here is optimistic. A component that flipped the
   * status locally and walked it back would pass every assertion in
   * `lifecycle-actions.test` and fail this one.
   */
  it('shows a refused Start — naming the event — and leaves the pill on Published', async () => {
    const detail =
      'This tournament cannot start yet: “Open Singles” has no draw yet. A draw is cut ' +
      'from the field as it stands at the time, and registration stays open right up ' +
      'to the moment a tournament goes live — so cut the draw for each event named ' +
      '(again, if somebody entered or withdrew since it was last cut), then start the ' +
      'tournament.'
    mockTournamentTransitionEndpoint(server, () =>
      HttpResponse.json({ detail }, { status: 409 }),
    )
    tournamentDetailPagePage.render({
      tournament: buildTournament({ id: 't-1', status: 'published' }),
    })

    await userEvent.click(
      tournamentDetailPagePage.getLifecycleButton(/Start tournament/),
    )

    const notice = await tournamentDetailPagePage.findLifecycleNoticeText()
    expect(notice).toContain("Couldn't start the tournament")
    expect(notice).toContain('“Open Singles” has no draw yet')

    expect(tournamentDetailPagePage.getStatusBadge()).toHaveTextContent('Published')
    expect(tournamentDetailPagePage.getStatusBadge()).toHaveAttribute(
      'data-status',
      'published',
    )
    // …and the button they were refused is still the button on offer, not "End
    // tournament" — the tournament did not move.
    expect(
      tournamentDetailPagePage.getLifecycleButton(/Start tournament/),
    ).toBeInTheDocument()
  })

  it('opens the event editor and creates a new event', async () => {
    const onCreateEvent = vi.fn().mockResolvedValue(undefined)
    tournamentDetailPagePage.render({
      tournament: buildTournament({ events: [] }),
      onCreateEvent,
    })

    await userEvent.click(tournamentDetailPagePage.getNewEventButton())
    // A new event starts unnamed (`emptyEvent`), and an unnamed event is a 422 —
    // which the form now refuses to send. So naming it is part of creating it.
    await userEvent.type(
      tournamentDetailPagePage.getEditorNameInput(),
      'Twilight Singles',
    )
    await userEvent.click(tournamentDetailPagePage.getEditorSaveButton())
    await waitFor(() => expect(onCreateEvent).toHaveBeenCalledTimes(1))
    expect(onCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Twilight Singles' }),
    )
    // A successful create closes the editor — and it is the ONLY thing that does.
    await waitFor(() => expect(tournamentDetailPagePage.queryEditor()).toBeNull())
  })

  /**
   * **The uncapped event, end to end** — the path neither branch of this merge had.
   *
   * `emptyEvent` seeds a cap of 32, so the organizer of an unlimited event has to
   * *clear* the box; the old editor read `Number('')` as `0` and sent an event of zero
   * players, which the server refused (`gt=0`) with a 422 the sheet swallowed. So the
   * two halves of the assertion are the two halves of the bug: `null` goes on the wire
   * (not `0`, not `NaN`), and the create is accepted rather than refused.
   *
   * `toHaveBeenCalledWith(objectContaining({maxPlayers: null}))` is the load-bearing
   * line: `expect.objectContaining({maxPlayers: 0})` would also pass a test that merely
   * checked "the create fired".
   */
  it('creates an event with NO player cap when the limit is left blank (ADR-0935)', async () => {
    const onCreateEvent = vi.fn().mockResolvedValue(undefined)
    tournamentDetailPagePage.render({
      tournament: buildTournament({ events: [] }),
      onCreateEvent,
    })

    await userEvent.click(tournamentDetailPagePage.getNewEventButton())
    await userEvent.type(
      tournamentDetailPagePage.getEditorNameInput(),
      'Club Night',
    )
    await userEvent.clear(tournamentDetailPagePage.getEditorPlayerLimitInput())
    await userEvent.click(tournamentDetailPagePage.getEditorSaveButton())

    await waitFor(() => expect(onCreateEvent).toHaveBeenCalledTimes(1))
    expect(onCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Club Night', maxPlayers: null }),
    )
    // Not a refusal: no banner, and the sheet closed because the save went through.
    expect(tournamentDetailPagePage.queryEditorFailure()).toBeNull()
    await waitFor(() => expect(tournamentDetailPagePage.queryEditor()).toBeNull())
  })

  it('refuses to create an UNNAMED event, and sends nothing (#783 QA)', async () => {
    // The blank name used to go to the server, come back a 422, and be reported —
    // in Pydantic's words ("String should have at least 1 character").
    const onCreateEvent = vi.fn()
    tournamentDetailPagePage.render({
      tournament: buildTournament({ events: [] }),
      onCreateEvent,
    })

    await userEvent.click(tournamentDetailPagePage.getNewEventButton())
    await userEvent.click(tournamentDetailPagePage.getEditorSaveButton())

    expect(onCreateEvent).not.toHaveBeenCalled()
    expect(tournamentDetailPagePage.queryEditor()).toBeInTheDocument()
    expect(tournamentDetailPagePage.queryEditorFailure()).toBeNull()
  })

  // The page's half of the data-loss bug: it used to fire the mutation and close
  // the editor in the same breath, so a 422 landed on a sheet that was already gone
  // and took every field the organizer had typed with it. The write is awaited now,
  // and only a RESOLVED one closes anything.
  it('keeps the event editor open when the create is REFUSED', async () => {
    // FastAPI's real 422 body — a `detail` ARRAY of Pydantic errors, whose `msg` is
    // machine prose the UI must never repeat (DEFINITION_OF_COMPLETE).
    const onCreateEvent = vi.fn().mockRejectedValue(
      new ApiError(422, 'String should have at most 255 characters', 'create event', {
        detail: [
          {
            type: 'string_too_long',
            loc: ['body', 'name'],
            msg: 'String should have at most 255 characters',
          },
        ],
      }),
    )
    tournamentDetailPagePage.render({
      tournament: buildTournament({ events: [] }),
      onCreateEvent,
    })

    await userEvent.click(tournamentDetailPagePage.getNewEventButton())
    await userEvent.type(
      tournamentDetailPagePage.getEditorNameInput(),
      'Twilight Singles',
    )
    await userEvent.click(tournamentDetailPagePage.getEditorSaveButton())

    await waitFor(() =>
      expect(tournamentDetailPagePage.queryEditorFailure()).toBeInTheDocument(),
    )
    // Our copy, naming the field the server blamed — not the server's own sentence.
    expect(tournamentDetailPagePage.queryEditorFailure()).toHaveTextContent(
      'The Event name was rejected',
    )
    expect(tournamentDetailPagePage.queryEditorFailure()).not.toHaveTextContent(
      'String should have at most',
    )
    expect(tournamentDetailPagePage.queryEditor()).toBeInTheDocument()
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
