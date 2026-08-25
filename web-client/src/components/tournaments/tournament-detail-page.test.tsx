import type { ReactNode } from 'react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'

// jsdom has no Google Maps runtime. Replace `@vis.gl/react-google-maps` with inert
// doubles that capture the marker's props, so the key-present branch of the venue
// `LocationMap` can be asserted (the pin lands on the tournament's stored
// coordinates) without loading Google. Keyless — the default vitest env — the
// component never touches these and renders its text fallback.
const { markerProps } = vi.hoisted(() => ({ markerProps: vi.fn() }))

vi.mock('@vis.gl/react-google-maps', () => ({
  APIProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Map: (props: { children: ReactNode }) => <div>{props.children}</div>,
  AdvancedMarker: (props: Record<string, unknown>) => {
    markerProps(props)
    return <div data-testid="mock-marker" />
  },
}))

import { ApiError } from '@/api/client'
import { mockSessionEndpoint } from '@/mocks/endpoints/session/session.endpoint'
import { mockTournamentTransitionEndpoint } from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import {
  buildTournamentDetailRead,
  UNBREAKABLE_VENUE_NAME,
} from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { PERM } from '@/lib/permissions'
import { sessionResponse } from '@/test/factories'
import { waitFor } from '@/test/utilities'

import {
  buildAddress,
  buildDrawnEvent,
  buildEvent,
  buildFixture,
  buildTables,
  buildTournament,
} from './data/seed.factory'
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

    // The real "no venue" state (CONTEXT.md, "Venue"): `address: null` — announced
    // before the room is booked, or a home game whose address is withheld. The
    // header shows the dates and nothing else where the venue would be.
    it('renders nothing — no meta item, no "TBD" — for a tournament with NO VENUE', () => {
      tournamentDetailPagePage.render({
        tournament: buildTournament({ address: null }),
      })

      expect(tournamentDetailPagePage.queryVenueLine()).toBeNull()
      // Never a placeholder: "TBD" promises a venue is coming (false when it is
      // withheld) and implies a private address is merely missing (#1206).
      expect(document.body).not.toHaveTextContent(/TBD/i)
      // …and the rest of the header is untouched — the dates are still there, so
      // this is a missing venue row and not a page that failed to render.
      expect(document.body).toHaveTextContent('Jun 13–14, 2026')
    })

    /**
     * A 680-character venue name with no break opportunity in it (#1199).
     *
     * ⚠️ **This is a supplement, not the proof.** The defect is that the page
     * scrolled sideways, and jsdom performs no layout: `scrollWidth` and
     * `clientWidth` are `0` for every element here, so an overflow assertion
     * written in this file would pass against the truncating version, the wrapping
     * version, and a version that renders the name 5742px wide. What vitest CAN
     * say is what the markup asks for and that nothing was dropped from it; the
     * measurement lives in `e2e/tournaments/tournament-venue.spec.ts`.
     */
    it('renders an unbroken 680-character venue in full, asking for a wrap', () => {
      tournamentDetailPagePage.render({
        tournament: buildTournament({
          address: buildAddress({
            venue: UNBREAKABLE_VENUE_NAME,
            city: '',
            region: '',
          }),
        }),
      })

      const text = tournamentDetailPagePage.queryVenueText()
      // Every character of it — the fix wraps the name, it does not hide it, so
      // there is no truncation, no ellipsis and no clamp of the text itself.
      expect(text).toHaveTextContent(UNBREAKABLE_VENUE_NAME)
      // `wrap-anywhere` and not `truncate`: only `overflow-wrap: anywhere` lowers
      // this flex item's min-content contribution, which is what stops it forcing
      // the header wider than the viewport (see the comment at the call site).
      expect(text).toHaveClass('wrap-anywhere')
      expect(text).not.toHaveClass('truncate')
      // No clamp either. Clamping would keep the page narrow while hiding the
      // organizer's own venue, which is the wrong outcome, not a lesser fix.
      expect(text?.className).not.toMatch(/line-clamp/)
    })
  })

  // The display-only venue map (chore 4d): opening a tournament shows its venue on
  // a map at the server-geocoded coordinates the read `Address` carries.
  describe('the venue map', () => {
    afterEach(() => markerProps.mockClear())

    it('mounts a venue map — labelled with the venue line — at the stored coordinates', () => {
      // The default vitest env is keyless, so `LocationMap` renders its text
      // fallback (labelled with the venue line) rather than loading Google.
      tournamentDetailPagePage.render({
        tournament: buildTournament({
          address: buildAddress({ latitude: 40.7128, longitude: -74.006 }),
        }),
      })

      expect(tournamentDetailPagePage.queryVenueMapFallback()).toHaveTextContent(
        'Berkeley TT Club · Berkeley, CA',
      )
    })

    it('centers the pin on the tournament coordinates when a Maps key is present', () => {
      vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-browser-key')
      tournamentDetailPagePage.render({
        tournament: buildTournament({
          address: buildAddress({ latitude: 40.7128, longitude: -74.006 }),
        }),
      })

      // The coords are threaded through, not the factory defaults: an
      // `objectContaining({ lat: 37.8715 })` would pass a wiring that ignored the
      // tournament and re-geocoded from nothing.
      expect(markerProps).toHaveBeenCalledWith(
        expect.objectContaining({ position: { lat: 40.7128, lng: -74.006 } }),
      )
      vi.unstubAllEnvs()
    })

    it('shows no venue map when the tournament has no address', () => {
      tournamentDetailPagePage.render({
        tournament: buildTournament({
          address: buildAddress({ venue: '', city: '', region: '' }),
        }),
      })

      expect(tournamentDetailPagePage.queryVenueMapFallback()).toBeNull()
    })

    // `address: null` has no coordinates to pin at all. Rendering the map anyway
    // would need a fallback pair, and the only one available is (0, 0) — which
    // would put a tournament held at somebody's home in the Gulf of Guinea, on a
    // public page, having been told not to show its address.
    it('mounts NO map — and no marker — for a tournament with NO VENUE', () => {
      vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-browser-key')
      tournamentDetailPagePage.render({
        tournament: buildTournament({ address: null }),
      })

      expect(tournamentDetailPagePage.queryVenueMapFallback()).toBeNull()
      // The keyed branch too: no marker was ever asked for, so nothing was pinned
      // at (0, 0). A fallback-only assertion would miss exactly that.
      expect(markerProps).not.toHaveBeenCalled()
      vi.unstubAllEnvs()
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
          dateRange: { start: '2026-08-22', end: '2026-08-22' },
          events: [],
        }),
      })
      expect(tournamentDetailPagePage.getDaysStat()).toBe('1day')
    })

    it('reads "days" for a multi-day tournament', () => {
      tournamentDetailPagePage.render({
        tournament: buildTournament({
          dateRange: { start: '2026-08-22', end: '2026-08-23' },
          events: [],
        }),
      })
      expect(tournamentDetailPagePage.getDaysStat()).toBe('2days')
    })

    // #1511: `dateRange` is `null` iff the tournament holds no events — the
    // em-dash is the designed "no span yet" state, not a fallback to a stale
    // client-computed value.
    it('shows the em-dash, with no unit, for a tournament with no dateRange', () => {
      tournamentDetailPagePage.render({
        tournament: buildTournament({ dateRange: null, events: [] }),
      })
      expect(tournamentDetailPagePage.getDaysStat()).toBe('—')
    })
  })

  it('shows "Dates set by events" copy in the header for a tournament with no dateRange', () => {
    tournamentDetailPagePage.render({
      tournament: buildTournament({ dateRange: null, events: [] }),
    })
    expect(document.body).toHaveTextContent(
      'Dates set by events — add one to begin.',
    )
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
    // Publishing is one-way, so it is priced first: the header's click opens the confirm
    // and the confirm's own button is what posts.
    await userEvent.click(tournamentDetailPagePage.lifecycleConfirm.getConfirmButton())

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
    await userEvent.click(tournamentDetailPagePage.lifecycleConfirm.getConfirmButton())

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

  /**
   * The same precondition, refusing over an event no cut could ever fix (#1300).
   *
   * The page-level claim is the one the ticket is about: the director reads the whole
   * refusal — each event, its own reason, its own fix — and reads **no instruction to cut
   * a draw**, because for these two events that click can only fail a second time. Before
   * #1300 the sentence ended "…so cut the draw for each event named", and the only escape
   * the QA pass found was deleting the event.
   *
   * The detail is hard-coded, exactly as the refusal above is, and for the same reason: a
   * test that read the copy out of the mock store it is testing against would pass
   * whatever the copy became.
   */
  it('shows an all-undrawable refused Start — every reason, and no cut instruction', async () => {
    const detail =
      'This tournament cannot start yet: “Doubles Event”: A doubles event cannot be ' +
      'given a draw — only singles events can. A fixture seats one entrant on each ' +
      'side, and there is nowhere to record a doubles pairing or a team. Remove the ' +
      'event. “Lone Event”: A single-elimination draw needs at least 2 entrants — a ' +
      'bracket of one has nobody to play. Add entrants, or remove the event.'
    mockTournamentTransitionEndpoint(server, () =>
      HttpResponse.json({ detail }, { status: 409 }),
    )
    tournamentDetailPagePage.render({
      tournament: buildTournament({ id: 't-1', status: 'published' }),
    })

    await userEvent.click(
      tournamentDetailPagePage.getLifecycleButton(/Start tournament/),
    )
    await userEvent.click(tournamentDetailPagePage.lifecycleConfirm.getConfirmButton())

    const notice = await tournamentDetailPagePage.findLifecycleNoticeText()
    expect(notice).toContain("Couldn't start the tournament")
    // Both events, each with the fix that actually works for it.
    expect(notice).toContain('“Doubles Event”: A doubles event cannot be given a draw')
    expect(notice).toContain('“Lone Event”: A single-elimination draw needs at least 2')
    expect(notice).toContain('Add entrants, or remove the event.')
    // …and the instruction that cannot be followed is absent.
    expect(notice).not.toContain('cut the draw')

    expect(tournamentDetailPagePage.getStatusBadge()).toHaveTextContent('Published')
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

  /**
   * Slice 3 (#791): a **permissioned non-owner viewer** — a beta user who holds
   * `tournament.view` but is neither the creator nor entitled to enter — opening a
   * published tournament gets it **fully read-only on every tab** (ADR-0015). This
   * is the page-level integration proof that `can_edit === false` reaches every tab:
   * the per-tab quartets each guard their own surface, but only this walks all four
   * of one page and sweeps each for the controls that must have leaked nowhere —
   * the edit forms, the cut/re-cut/delete draw verbs, the lifecycle transitions, the
   * table-catalogue editor, the placement control, and any Enter/Withdraw the viewer
   * was never granted.
   *
   * The tournament carries a **cut, partly-scheduled draw** so every tab has real
   * content to be read-only *about*: the Events tab shows the draw, the Schedule tab
   * shows a placed match and an awaiting one — the exact surfaces the owner's verbs
   * would hang off.
   */
  describe('a permissioned non-owner viewer gets a read-only page (#791, ADR-0015)', () => {
    /** A drawn event with one fixture PLACED on `t1` and one still awaiting a table
     * — the two groups the Schedule tab renders. The placed fixture carries a
     * `tableId` + time but NO `matchId`: a published tournament's fixtures are placed
     * before go-live, and only materialize into real matches when the tournament
     * starts (ADR-0790), so no match-link renders here. */
    const buildScheduledEvent = () =>
      buildDrawnEvent({
        fixtures: [
          buildFixture({
            id: 'fx-a-1',
            round: 1,
            position: 1,
            entryAId: 'entry-1',
            entryBId: 'entry-4',
            tableId: 't1',
            scheduledStart: '2026-06-13T09:00:00',
          }),
          buildFixture({
            id: 'fx-a-2',
            round: 2,
            position: 1,
            entryAId: 'entry-1',
            entryBId: 'entry-5',
          }),
        ],
      })

    /** A published tournament (a non-owner can see it — a draft would 404, #967)
     * with the scheduled draw, seen by a spectator who holds `tournament.view` only
     * (no `tournament.enter`, and `can_edit: false`). */
    const renderAsSpectator = () => {
      mockSessionEndpoint(server, () =>
        HttpResponse.json(
          sessionResponse({
            user: { username: 'spectator', permissions: [PERM.TOURNAMENT_VIEW] },
          }),
        ),
      )
      tournamentDetailPagePage.render({
        tournament: buildTournament({
          status: 'published',
          canEdit: false,
          events: [buildScheduledEvent()],
        }),
        allTables: buildTables(6),
      })
    }

    it('renders the Details tab as values, with no edit controls', async () => {
      renderAsSpectator()
      await tournamentDetailPagePage.findSessionReady()

      await userEvent.click(tournamentDetailPagePage.getTab(/^Details/))
      expect(tournamentDetailPagePage.getActiveTabControls()).toHaveLength(0)
    })

    it('renders the Tables tab as a list, with no catalogue editor', async () => {
      renderAsSpectator()
      await tournamentDetailPagePage.findSessionReady()

      await userEvent.click(tournamentDetailPagePage.getTab(/^Tables/))
      // The list is still there to read…
      expect(tournamentDetailPagePage.getActiveTabPanel()).toHaveTextContent('T1')
      // …but the add-table form and the per-row Remove buttons are gone.
      expect(tournamentDetailPagePage.getActiveTabControls()).toHaveLength(0)
    })

    it('renders the Schedule tab as a view, with no placement control', async () => {
      renderAsSpectator()
      await tournamentDetailPagePage.findSessionReady()

      await userEvent.click(tournamentDetailPagePage.getTab(/^Schedule/))
      // The schedule renders (the placed match sits in its table column)…
      expect(tournamentDetailPagePage.getActiveTabPanel()).toHaveTextContent(
        'player.1 vs player.4',
      )
      // …with no Place / Move trigger anywhere: the only controls left are the
      // view toggle's three items (List | Gantt | Player timeline) — a reading
      // choice, the Events tab's "View" open-target precedent (ADR-0015).
      const controls = tournamentDetailPagePage.getActiveTabControls()
      expect(controls.length).toBeGreaterThan(0)
      expect(
        controls.every(
          (el) => el.closest('[data-testid="schedule-view-toggle"]') !== null,
        ),
      ).toBe(true)
    })

    it('renders the Events tab with only the read-only "View" open target — no owner or entry affordance', async () => {
      renderAsSpectator()
      await tournamentDetailPagePage.findSessionReady()

      // Events is the default tab; select it explicitly so the assertion is uniform.
      await userEvent.click(tournamentDetailPagePage.getTab(/^Events/))

      const controls = tournamentDetailPagePage.getActiveTabControls()
      // The card is openable — into a read-only view (ADR 0015). That open target is
      // the ONLY interactive control the tab offers a viewer: no "New event", no
      // Generate/Re-cut/Delete draw verbs, and no Enter/Withdraw (the spectator holds
      // no `tournament.enter`).
      expect(controls.length).toBeGreaterThan(0)
      expect(
        controls.every((el) => /^View /.test(el.getAttribute('aria-label') ?? '')),
      ).toBe(true)
      expect(tournamentDetailPagePage.queryNewEventButtons()).toHaveLength(0)
    })

    it('offers no lifecycle transition in the header', async () => {
      renderAsSpectator()
      await tournamentDetailPagePage.findSessionReady()

      // Published → the OWNER would be offered "Start tournament"; a viewer is not.
      expect(
        tournamentDetailPagePage.queryLifecycleButton(/Start tournament/),
      ).toBeNull()
    })

    // The other half of ADR-0015: the gating must not be over-broad. The owner of the
    // very same tournament still gets the full controls on every tab — so a "hide it
    // from everyone" regression that satisfied the sweeps above is caught here.
    it('still gives the OWNER interactive controls on every tab', async () => {
      tournamentDetailPagePage.render({
        tournament: buildTournament({
          status: 'published',
          canEdit: true,
          events: [buildScheduledEvent()],
        }),
        allTables: buildTables(6),
      })

      // The header lifecycle action (Publish/Start/End) is the owner's alone.
      expect(
        tournamentDetailPagePage.getLifecycleButton(/Start tournament/),
      ).toBeInTheDocument()

      for (const tab of [/^Events/, /^Tables/, /^Schedule/, /^Details/]) {
        await userEvent.click(tournamentDetailPagePage.getTab(tab))
        expect(
          tournamentDetailPagePage.getActiveTabControls().length,
        ).toBeGreaterThan(0)
      }
    })
  })
})
