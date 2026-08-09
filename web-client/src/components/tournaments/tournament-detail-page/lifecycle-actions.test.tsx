import userEvent from '@testing-library/user-event'
import { delay, HttpResponse } from 'msw'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockTournamentTransitionEndpoint } from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentDetailRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { waitFor } from '@/test/utilities'

import { buildAddress, buildEvent, buildTournament } from '../data/seed.factory'
import type { Tournament } from '../data/types'
import {
  buildEmptyTournament,
  buildRecutDrawTournament,
  buildStaleDrawTournament,
} from './lifecycle-actions.factory'
import { lifecycleActionsPage } from './lifecycle-actions.page'

vi.mock('sonner', async () => {
  const actual = await vi.importActual<typeof import('sonner')>('sonner')
  return {
    ...actual,
    toast: { ...actual.toast, error: vi.fn(), info: vi.fn(), success: vi.fn() },
  }
})

beforeEach(() => {
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.info).mockClear()
  vi.mocked(toast.success).mockClear()
})

/** The transitions endpoint, recording what the button actually sent. The 201
 * body is a bare `TournamentRead` (no events), as the API answers. */
function captureTransition() {
  const seen: { url: string; body: unknown }[] = []
  mockTournamentTransitionEndpoint(server, async ({ request }) => {
    seen.push({ url: request.url, body: await request.json() })
    const { events, ...read } = buildTournamentDetailRead()
    void events
    return HttpResponse.json(read, { status: 201 })
  })
  return seen
}

/** The transitions endpoint, refusing with `status` and the server's own `detail` —
 * the shape every refusal below arrives in (FastAPI's `{"detail": "…"}`). */
function refuseTransition(status: number, detail: string) {
  mockTournamentTransitionEndpoint(server, () =>
    HttpResponse.json({ detail }, { status }),
  )
}

/** One shape of the go-live 409, short enough to read in an assertion: the server naming
 * the event whose draw is missing. Hard-coded, not read from the mock store — a test that
 * took the copy from the code it is testing would pass whatever the copy became. */
const NO_DRAW_FOR_OPEN_SINGLES =
  'This tournament cannot start yet: “Open Singles” has no draw yet.'

/** Click **Start tournament** on a published tournament the viewer owns, and pay for it —
 * the one edge that carries a precondition (ADR-0786). Two clicks, because the button
 * opens the confirm and the confirm's own button is what posts. Hands back the render's
 * `rerenderWith`, so a test can go on to give the component fresh server data without
 * clicking anything else. */
async function clickStart(
  tournament: Tournament = buildTournament({ id: 't-1', status: 'published' }),
) {
  const handle = lifecycleActionsPage.render({ tournament })
  await userEvent.click(lifecycleActionsPage.getLifecycleButton(/Start tournament/))
  await userEvent.click(lifecycleActionsPage.confirm.getConfirmButton())
  return handle
}

/** No toast, ever, for a refusal this component reports inline (`web-client/CLAUDE.md`,
 * ## Forms: a mutation surfaced inline must not also toast). Asserted on EVERY ring of
 * the toaster, because "no error toast" would go green against a refusal announced as a
 * cheerful `toast.success`. */
function expectNoToast() {
  expect(toast.error).not.toHaveBeenCalled()
  expect(toast.info).not.toHaveBeenCalled()
  expect(toast.success).not.toHaveBeenCalled()
}

describe('LifecycleActions', () => {
  // Each row is one edge of the forward-only lifecycle (ADR-0017): the button a
  // status offers, and the status it moves to. Table-driven so a fourth button —
  // or a button offered from the wrong status — cannot slip in unnoticed.
  it.each([
    { status: 'draft', label: /Publish/, to: 'published' },
    { status: 'published', label: /Start tournament/, to: 'live' },
    { status: 'live', label: /End tournament/, to: 'archived' },
  ] as const)(
    'posts { to: "$to" } to the transitions endpoint from $status',
    async ({ status, label, to }) => {
      const seen = captureTransition()
      lifecycleActionsPage.render({
        tournament: buildTournament({ id: 't-1', status }),
      })

      await userEvent.click(lifecycleActionsPage.getLifecycleButton(label))
      // The act is the CONFIRM's button, never the header's (see the confirm suite
      // below). The header's click only asks the question.
      await userEvent.click(lifecycleActionsPage.confirm.getConfirmButton())

      // The transitions RESOURCE, not a status-carrying PATCH: `TournamentUpdate`
      // has no `status` field, so a PATCH here would be a no-op that looked fine.
      await waitFor(() => expect(seen).toHaveLength(1))
      expect(seen[0].url).toContain('/v1/tournaments/t-1/transitions')
      expect(seen[0].body).toEqual({ to })
      // A move that WORKED says nothing — no notice, no toast.
      expect(lifecycleActionsPage.queryNotice()).toBeNull()
      expectNoToast()
    },
  )

  it('offers only the edge legal from the current status', () => {
    lifecycleActionsPage.render({
      tournament: buildTournament({ status: 'draft' }),
    })

    expect(
      lifecycleActionsPage.getLifecycleButton(/Publish/),
    ).toBeInTheDocument()
    expect(lifecycleActionsPage.queryAllButtons()).toHaveLength(1)
  })

  // `archived` is terminal: there is no edge out of it, so there is no button —
  // rather than a button that could only ever be refused.
  it('offers nothing on an archived tournament', () => {
    lifecycleActionsPage.render({
      tournament: buildTournament({ status: 'archived' }),
    })
    expect(lifecycleActionsPage.queryAllButtons()).toHaveLength(0)
  })

  // Hidden, never disabled (ADR 0015): transitions are owner-only server-side, so
  // a viewer is offered no lifecycle affordance at all.
  //
  // The non-owner's tournament is `published`, because that is the only kind of
  // tournament a non-owner can be looking at: a draft is owner-only to READ now, and
  // a stranger's GET of one is a 404 (#967), so this component never renders for a
  // draft it does not own. `published` is a status with a live edge out of it ("Start
  // tournament"), so there is a button here for the gate to actually withhold.
  it('renders nothing for a non-owner', () => {
    lifecycleActionsPage.render({
      tournament: buildTournament({ status: 'published', canEdit: false }),
    })
    expect(lifecycleActionsPage.queryAllButtons()).toHaveLength(0)
  })

  // (`hasLifecycleAction` — what the header asks before it renders the slot at
  // all — is the same table, and is tested in `../data/lifecycle.test.ts`.)
})

// The go-live precondition (ADR-0786), as the director meets it. Going live seals the
// field and turns every ready fixture into a match, so the server refuses it unless the
// tournament has events, every event has a draw, and every draw still seats exactly its
// entrants. The refusal is a 409 whose sentence NAMES the events at fault — and the
// whole job of this component is to put that sentence in front of the person who can act
// on it.
// The three shapes of the server's detail, verbatim (`_go_live_refusal`,
// `api/app/tournaments.py`). Hard-coded here rather than imported from the mock store:
// a test that read the copy from the code it is testing would pass whatever the copy
// became.
const NOTHING_TO_START =
  'This tournament has no events, so there is nothing to start. Add an event and cut ' +
  'its draw, then start the tournament.'
const NO_DRAW =
  'This tournament cannot start yet: “Open Singles” has no draw yet. A draw is cut ' +
  'from the field as it stands at the time, and registration stays open right up to ' +
  'the moment a tournament goes live — so cut the draw for each event named (again, ' +
  'if somebody entered or withdrew since it was last cut), then start the tournament.'
const STALE_DRAW =
  'This tournament cannot start yet: “Under 1200” has a draw that no longer matches ' +
  'its entrants. A draw is cut from the field as it stands at the time, and ' +
  'registration stays open right up to the moment a tournament goes live — so cut ' +
  'the draw for each event named (again, if somebody entered or withdrew since it ' +
  'was last cut), then start the tournament.'

describe('LifecycleActions · a refused Start tournament (409)', () => {
  const TWO_EVENTS =
    'This tournament cannot start yet: “Under 1200” has no draw yet; and “Over 40s” ' +
    'has a draw that no longer matches its entrants. A draw is cut from the field as ' +
    'it stands at the time, and registration stays open right up to the moment a ' +
    'tournament goes live — so cut the draw for each event named (again, if somebody ' +
    'entered or withdrew since it was last cut), then start the tournament.'

  // Each of the three refusals renders — and renders the SERVER's sentence, which is the
  // only half that says what to go and do. The assertions name the *events*, because a
  // test that asserted merely "an error is shown" would pass just as happily against a
  // generic "something went wrong".
  it.each([
    { name: 'an empty tournament', detail: NOTHING_TO_START, names: ['no events'] },
    { name: 'an event with no draw', detail: NO_DRAW, names: ['“Open Singles”'] },
    {
      name: 'an event whose draw is stale',
      detail: STALE_DRAW,
      names: ['“Under 1200”'],
    },
    {
      name: 'two events, each at fault in its own way',
      detail: TWO_EVENTS,
      names: ['“Under 1200”', '“Over 40s”'],
    },
  ])('names what is wrong — $name', async ({ detail, names }) => {
    refuseTransition(409, detail)

    await clickStart()

    const text = await lifecycleActionsPage.findNoticeText()
    // The client's framing…
    expect(text).toContain("Couldn't start the tournament")
    // …around the server's sentence, whole.
    expect(text).toContain(detail)
    for (const name of names) expect(text).toContain(name)
    expect(await lifecycleActionsPage.findNoticeKind()).toBe('refused')
  })

  it('does NOT toast the refusal it has already shown inline', async () => {
    refuseTransition(409, NO_DRAW)

    await clickStart()

    await lifecycleActionsPage.findNotice()
    // Told once. A toast on top of this would say the same thing twice, and would take
    // the work list away after four seconds.
    expectNoToast()
  })

  it('leaves the tournament PUBLISHED — the button it refused is the button still on offer', async () => {
    refuseTransition(409, NO_DRAW)

    await clickStart()

    await lifecycleActionsPage.findNotice()
    // Nothing is optimistic here: the status this component renders from is the one the
    // server last confirmed, so a refused start still offers **Start tournament** — not
    // "End tournament", which is what a hopeful local flip to `live` would have produced.
    expect(
      lifecycleActionsPage.getLifecycleButton(/Start tournament/),
    ).toBeInTheDocument()
    expect(
      lifecycleActionsPage.queryLifecycleButton(/End tournament/),
    ).toBeNull()
  })

  // The OTHER 409 the same endpoint answers: a stale tab re-asserting an edge that no
  // longer exists. It carries no code, so the client cannot (and need not) tell it from
  // the precondition — and it must not: both are sentences written for the director, and
  // both are shown.
  it('shows the stale-tab 409 the same way — the server’s sentence, not a guess', async () => {
    refuseTransition(409, 'This tournament is already live.')

    await clickStart()

    const text = await lifecycleActionsPage.findNoticeText()
    expect(text).toContain('This tournament is already live.')
    expectNoToast()
  })
})

// Every other way the click can fail. Each is a designed case of one sum type
// (`LifecycleRefusal`) — there is no arm that fails silently, because there is no toast
// left to catch what an arm forgot.
describe('LifecycleActions · the other outcomes', () => {
  it('says so when the tournament is not yours (403)', async () => {
    refuseTransition(403, 'Only the creator can move this tournament.')

    await clickStart()

    const text = await lifecycleActionsPage.findNoticeText()
    expect(await lifecycleActionsPage.findNoticeKind()).toBe('forbidden')
    expect(text).toContain("You can't move this tournament")
    expect(text).toContain('Nothing was changed.')
    expectNoToast()
  })

  it('says so when the session is gone (401)', async () => {
    refuseTransition(401, 'Not authenticated')

    await clickStart()

    const text = await lifecycleActionsPage.findNoticeText()
    expect(await lifecycleActionsPage.findNoticeKind()).toBe('signed-out')
    expect(text).toContain('You are signed out')
    // The verb of the edge they clicked — "sign in again, then start the tournament".
    expect(text).toContain('start the tournament')
    // Never the wire's own words for it.
    expect(text).not.toContain('Not authenticated')
    expectNoToast()
  })

  it('owns the failure when the server breaks (5xx) — and does not repeat its detail', async () => {
    refuseTransition(500, 'Internal Server Error')

    await clickStart()

    const text = await lifecycleActionsPage.findNoticeText()
    expect(await lifecycleActionsPage.findNoticeKind()).toBe('server-error')
    expect(text).toContain('Something went wrong on our end')
    // A 5xx detail is machinery, not copy (`DEFINITION_OF_COMPLETE`: raw API detail
    // strings never reach the UI).
    expect(text).not.toContain('Internal Server Error')
    expectNoToast()
  })

  it('says the request never got there when the network is down', async () => {
    mockTournamentTransitionEndpoint(server, () => HttpResponse.error())

    await clickStart()

    const text = await lifecycleActionsPage.findNoticeText()
    expect(await lifecycleActionsPage.findNoticeKind()).toBe('unreachable')
    expect(text).toContain('Check your connection')
    expectNoToast()
  })

  // The refusal is about the LAST click, never the one before it: a director who fixes
  // the draw and starts again must not be left staring at the sentence that told them to.
  it('clears the last refusal when the next attempt succeeds', async () => {
    refuseTransition(409, 'This tournament cannot start yet: “Open Singles” has no draw yet.')

    await clickStart()
    await lifecycleActionsPage.findNotice()

    captureTransition()
    await userEvent.click(
      lifecycleActionsPage.getLifecycleButton(/Start tournament/),
    )
    // The standing refusal is STILL there at this point — opening the confirm is not an
    // attempt, and the 409's work list is what the director is reading while they decide.
    // It is cleared by the next attempt, not by the next question. Read by testid, not by
    // role: the open dialog aria-hides everything behind it.
    expect(lifecycleActionsPage.queryNoticeElement()).not.toBeNull()

    await userEvent.click(lifecycleActionsPage.confirm.getConfirmButton())

    await waitFor(() =>
      expect(lifecycleActionsPage.queryNotice()).toBeNull(),
    )
  })
})

// **A refusal expires** (`CONTEXT.md`, "Refusal"): it is a statement about a moment, and
// it stops being true the instant the state it describes changes. Nobody clicks anything
// in these tests after the first attempt — the tournament simply refetches, as it does on
// every mutation's settle, and the sentence either withdraws itself or stays.
describe('LifecycleActions · a refusal outlives its state only until the state moves', () => {
  // #1216 / #1049 Repro A, as reported: publish with no events, click Start, add an event
  // — and the header went on saying "there is nothing to start" above a page reading
  // `1 EVENTS`, until the director clicked Start a second time.
  it('withdraws "there is nothing to start" when the tournament gains an event — with no second click', async () => {
    refuseTransition(409, NOTHING_TO_START)
    const empty = buildEmptyTournament()
    const { rerenderWith } = await clickStart(empty)
    expect(await lifecycleActionsPage.findNoticeText()).toContain(
      'no events, so there is nothing to start',
    )

    // The director adds an event; the page refetches and re-renders with it.
    rerenderWith({ tournament: { ...empty, events: [buildEvent()] } })

    expect(lifecycleActionsPage.queryNotice()).toBeNull()
    // The affordance is untouched — the refusal went, the button it was about did not.
    expect(
      lifecycleActionsPage.getLifecycleButton(/Start tournament/),
    ).toBeInTheDocument()
  })

  // The other half of the precondition, and the half a count-based rule would miss: the
  // draw is re-cut over the same-sized field (one player withdrew, one entered), so every
  // count on the page is unchanged and only *who is seated* has moved.
  it('withdraws a stale-draw refusal when the draw is re-cut', async () => {
    refuseTransition(409, STALE_DRAW)
    const { rerenderWith } = await clickStart(buildStaleDrawTournament())
    expect(await lifecycleActionsPage.findNoticeText()).toContain(
      'has a draw that no longer matches its entrants',
    )

    rerenderWith({ tournament: buildRecutDrawTournament() })

    expect(lifecycleActionsPage.queryNotice()).toBeNull()
  })

  // The other direction, and the more expensive mistake: the refusal is a **work list**
  // ("cut the draw for each event named"), and it is what the director reads *while* going
  // to fix it. An edit to something it does not turn on must leave it exactly where it is —
  // a rule that cleared on any fresh data would take the list away mid-fix (ADR-0786).
  it('keeps the refusal when something it does not turn on changes', async () => {
    refuseTransition(409, STALE_DRAW)
    const stale = buildStaleDrawTournament()
    const { rerenderWith } = await clickStart(stale)
    await lifecycleActionsPage.findNotice()

    // The director renames the tournament and books a venue — neither is anything the
    // go-live precondition reads.
    rerenderWith({
      tournament: {
        ...stale,
        name: 'Bay Area Open 2026 (rescheduled)',
        address: buildAddress({ venue: 'Fremont Table Tennis Academy' }),
      },
    })

    // Synchronously: the refusal was already on screen, so there is nothing to wait for,
    // and expiry is decided in the same render that sees the new data.
    expect(lifecycleActionsPage.queryNoticeText()).toContain(
      'has a draw that no longer matches its entrants',
    )
  })

  // The status is NOT part of what a refusal turns on, and this is the case that decides
  // it: the stale-tab 409 is *about* the status having moved, and the very click that earns
  // it reconciles the view (the mutation refetches on settle, failure path included). A
  // fingerprint that included the status would withdraw this sentence in the same beat it
  // arrived — the user watching the badge correct itself and never learning why their click
  // did nothing.
  it('keeps the stale-tab refusal through the reconcile that click causes', async () => {
    refuseTransition(409, 'This tournament is already published.')
    const stale = buildTournament({ id: 't-1', status: 'draft' })
    const { rerenderWith } = lifecycleActionsPage.render({ tournament: stale })
    await userEvent.click(lifecycleActionsPage.getLifecycleButton(/Publish/))
    // The button only ASKS; the confirm's own button is what posts the transition (#1287).
    await userEvent.click(lifecycleActionsPage.confirm.getConfirmButton())
    await lifecycleActionsPage.findNotice()

    // The refetch lands: the page stops offering the edge it was just refused…
    rerenderWith({ tournament: { ...stale, status: 'published' } })

    // …and still says why.
    expect(lifecycleActionsPage.queryNoticeText()).toContain(
      'This tournament is already published.',
    )
    expect(
      lifecycleActionsPage.getLifecycleButton(/Start tournament/),
    ).toBeInTheDocument()
  })
})

/**
 * **The confirm is what moves the tournament** (ADR "a confirm prices an irreversible act,
 * a freeze explains an illegal one"). The lifecycle is forward-only — `draft → published
 * → live → archived`, no edge back, `archived` terminal — so all three edges are one-way
 * and all three are priced. None is exempt, and **Start** least of all: since #788 it does
 * not merely relabel the tournament, it closes registration and mints a match for every
 * ready fixture.
 */
describe('LifecycleActions · the confirm on every edge', () => {
  /** What a successful transition answers with — a bare `TournamentRead`, as the API
   * sends it. The stubs below are never *meant* to answer, but the body must still be one
   * the parser accepts: a mutant that leaked a request past the confirm would otherwise
   * reject on the payload rather than on the thing under test. */
  const transitionRead = () => {
    const { events, ...read } = buildTournamentDetailRead()
    void events
    return read
  }

  /** The panel's own controls that are still LIVE — swept by DOM rather than by role,
   * because an open dialog puts `aria-hidden` over everything behind it and a role query
   * then finds none of them. A header offers exactly one lifecycle button, and it goes
   * dead while a transition is in flight, so the count is a synchronous read of "nothing
   * was sent". */
  const liveControls = () =>
    lifecycleActionsPage
      .getActionControls()
      .filter((el) => !el.hasAttribute('disabled'))

  /**
   * The endpoint **hangs** (`delay('infinite')`) in these three, and that is what makes
   * them evidence rather than a race. An edge wired to the dialog *and* the mutation would
   * send a request that completes in milliseconds, and by the time an assertion ran
   * `isPending` would be back to false and the header would look untouched. A request that
   * never answers cannot settle away: it holds the button disabled for as long as the test
   * cares to look, so "the button is still live" is a second witness to "nothing was sent"
   * that does not depend on when MSW got there.
   */
  it.each([
    { status: 'draft', label: /Publish/, title: 'Publish this tournament?' },
    {
      status: 'published',
      label: /Start tournament/,
      title: 'Start this tournament?',
    },
    { status: 'live', label: /End tournament/, title: 'End this tournament?' },
  ] as const)(
    'sends NOTHING on a bare click from $status — the dialog is what gates it',
    async ({ status, label, title }) => {
      let calls = 0
      mockTournamentTransitionEndpoint(server, async () => {
        calls += 1
        await delay('infinite')
        const { events, ...read } = buildTournamentDetailRead()
        void events
        return HttpResponse.json(read, { status: 201 })
      })
      lifecycleActionsPage.render({
        tournament: buildTournament({ id: 't-1', status }),
      })

      await userEvent.click(lifecycleActionsPage.getLifecycleButton(label))

      // Settle on the dialog first — the count is only evidence once the click has been
      // given somewhere to have gone. Bounded under `testTimeout`, so a failure reads
      // "unable to find role=alertdialog" rather than an undiscriminated 5s timeout
      // (`web-client/CLAUDE.md`).
      await waitFor(
        () => expect(lifecycleActionsPage.confirm.getDialog()).toBeInTheDocument(),
        { timeout: 2000 },
      )
      // …and it priced THIS edge, not another one.
      expect(lifecycleActionsPage.confirm.getDialog()).toHaveTextContent(title)
      expect(calls).toBe(0)
      expect(liveControls()).toHaveLength(1)
      expectNoToast()
    },
  )

  // Go back is a no-op: the tournament stands exactly where it was, and the button that
  // named the edge is still on offer — the director changed their mind, they did not
  // spend anything.
  it('sends nothing when the director goes back', async () => {
    let calls = 0
    mockTournamentTransitionEndpoint(server, () => {
      calls += 1
      return HttpResponse.json(transitionRead(), { status: 201 })
    })
    lifecycleActionsPage.render({
      tournament: buildTournament({ id: 't-1', status: 'draft' }),
    })

    await userEvent.click(lifecycleActionsPage.getLifecycleButton(/Publish/))
    await userEvent.click(lifecycleActionsPage.confirm.getCancelButton())

    await waitFor(() =>
      expect(lifecycleActionsPage.confirm.queryDialog()).toBeNull(),
    )
    expect(calls).toBe(0)
    expect(
      lifecycleActionsPage.getLifecycleButton(/Publish/),
    ).toBeInTheDocument()
    // A cancel is not a failure: there is nothing to explain, so there is no notice.
    expect(lifecycleActionsPage.queryNotice()).toBeNull()
    expectNoToast()
  })

  it('sends nothing when the dialog is dismissed with Escape', async () => {
    let calls = 0
    mockTournamentTransitionEndpoint(server, () => {
      calls += 1
      return HttpResponse.json(transitionRead(), { status: 201 })
    })
    lifecycleActionsPage.render({
      tournament: buildTournament({ id: 't-1', status: 'live' }),
    })

    await userEvent.click(lifecycleActionsPage.getLifecycleButton(/End tournament/))
    await userEvent.keyboard('{Escape}')

    await waitFor(() =>
      expect(lifecycleActionsPage.confirm.queryDialog()).toBeNull(),
    )
    expect(calls).toBe(0)
    expect(
      lifecycleActionsPage.getLifecycleButton(/End tournament/),
    ).toBeInTheDocument()
  })

  // One in-flight move at a time. The confirm does NOT make this redundant — it asks a
  // question once, per click, and two clicks would ask it twice. The lock is what stops
  // the second one being asked at all.
  it('locks the button while a move is in flight, so the question cannot be asked twice', async () => {
    let calls = 0
    mockTournamentTransitionEndpoint(server, async () => {
      calls += 1
      await delay('infinite')
      return HttpResponse.json(transitionRead(), { status: 201 })
    })
    lifecycleActionsPage.render({
      tournament: buildTournament({ id: 't-1', status: 'draft' }),
    })

    const publish = lifecycleActionsPage.getLifecycleButton(/Publish/)
    await userEvent.click(publish)
    await userEvent.click(lifecycleActionsPage.confirm.getConfirmButton())

    await waitFor(() => expect(publish).toBeDisabled())
    await userEvent.click(publish)
    expect(calls).toBe(1)
    // …and the second click did not even get as far as the question: a locked edge opens
    // no dialog. Without this the assertion above would only be saying that a disabled
    // button is disabled, since the move now needs a confirm it never got.
    expect(lifecycleActionsPage.confirm.queryDialog()).toBeNull()
  })

  // The confirm is the only new gate: a non-owner still gets no button to open it with,
  // and the terminal `archived` still offers none — hidden, never disabled (ADR-0015).
  it.each([
    { name: 'a non-owner', tournament: { status: 'published', canEdit: false } },
    { name: 'an archived tournament', tournament: { status: 'archived' } },
  ] as const)('gives $name no button, and therefore no dialog', ({ tournament }) => {
    lifecycleActionsPage.render({ tournament: buildTournament(tournament) })

    expect(lifecycleActionsPage.queryAllButtons()).toHaveLength(0)
    expect(lifecycleActionsPage.confirm.queryDialog()).toBeNull()
  })

  // The dialog names the TOURNAMENT — by its name, which is the only handle a director
  // has on it. Pinned because a component that passed `tournament.id` instead renders a
  // sentence that is still grammatical, still one line, and still passed every other test
  // in this file: "Starting bay-area-open-2026 closes registration for good".
  it('names the tournament the director is about to move — its name, not its id', async () => {
    lifecycleActionsPage.render({
      tournament: buildTournament({
        id: 't-1',
        name: 'Bay Area Open 2026',
        status: 'published',
      }),
    })

    await userEvent.click(
      lifecycleActionsPage.getLifecycleButton(/Start tournament/),
    )

    const dialog = lifecycleActionsPage.confirm.getDialog()
    expect(dialog).toHaveTextContent('Bay Area Open 2026')
    // The discriminating half: the id must not be what reached the copy.
    expect(dialog).not.toHaveTextContent('t-1')
  })
})

/**
 * **The confirm posts the edge it PRICED** — the regression this file exists to hold shut.
 *
 * `edge` is recomputed from the `tournament` prop on every render, and this page polls
 * (`useSchedulePolling`, ~3s on the Schedule tab). So the tournament can move underneath an
 * open dialog: a co-director starts it from their phone while this director is reading
 * "Start this tournament?", the refetch lands, and `edge` becomes `live → archived`.
 *
 * With the edge read live at confirm time, clicking **Start the tournament** posted
 * `{ to: 'archived' }` — the app ENDING a tournament under a dialog that had just described
 * starting it. Capturing the edge at the click is the fix, and a stale capture is the
 * designed outcome: `(current, to)` is the server's judgement (ADR-0017), so it answers 409
 * and this component renders that sentence inline. Being told beats silently performing an
 * act nobody chose.
 */
describe('LifecycleActions · a refetch under the open confirm', () => {
  it('posts the edge the dialog PRICED, not the one the refetch moved on to', async () => {
    const seen = captureTransition()
    const { rerenderWith } = lifecycleActionsPage.render({
      tournament: buildTournament({ id: 't-1', status: 'published' }),
    })

    // The director opens the confirm on `published → live`.
    await userEvent.click(
      lifecycleActionsPage.getLifecycleButton(/Start tournament/),
    )
    expect(lifecycleActionsPage.confirm.getDialog()).toHaveTextContent(
      'Start this tournament?',
    )

    // …and the tournament moves underneath them: somebody else started it, the poll
    // landed, and the edge this component would compute is now `live → archived`.
    rerenderWith({ tournament: buildTournament({ id: 't-1', status: 'live' }) })

    // The refetch LANDED — the positive witness, and the half this test cannot do
    // without: the dialog's own copy comes from the captured edge, so it reads "Start
    // this tournament?" whether the new prop applied or not, and a `rerenderWith` that
    // silently did nothing would leave every other assertion here green. The HEADER's
    // button is the thing that moves, and it has moved on to `live → archived`.
    //
    // Read by DOM sweep, not by role: Radix marks everything behind the open modal
    // `aria-hidden`, so `getByRole('button')` finds none of these and would report the
    // header as empty either way.
    expect(
      lifecycleActionsPage.getActionControls().map((el) => el.textContent),
    ).toEqual(['End tournament'])

    // And the question they are answering is still the question they were asked.
    expect(lifecycleActionsPage.confirm.getDialog()).toHaveTextContent(
      'Start this tournament?',
    )

    await userEvent.click(lifecycleActionsPage.confirm.getConfirmButton())

    await waitFor(() => expect(seen).toHaveLength(1))
    // The whole regression, in one line: `{ to: 'live' }` is the act that was priced.
    // `{ to: 'archived' }` is the act the live `edge` would have performed — ending the
    // tournament — and it is a request too, so "something was sent" would pass either way.
    expect(seen[0].body).toEqual({ to: 'live' })
  })

  /** The same capture, seen from the other end: a captured edge the server has since
   * refused is a **409**, and the notice frames it with the edge the director actually
   * clicked. A refusal titled after the edge now on offer would tell them the wrong move
   * failed. */
  it('reports a refused stale edge as the move the director made', async () => {
    refuseTransition(409, 'This tournament is already live.')
    const { rerenderWith } = lifecycleActionsPage.render({
      tournament: buildTournament({ id: 't-1', status: 'published' }),
    })

    await userEvent.click(
      lifecycleActionsPage.getLifecycleButton(/Start tournament/),
    )
    // No landing witness of its own: the test above pins that this same `rerenderWith`
    // reaches the component, so a helper that stopped working reds there first.
    rerenderWith({ tournament: buildTournament({ id: 't-1', status: 'live' }) })
    await userEvent.click(lifecycleActionsPage.confirm.getConfirmButton())

    const text = await lifecycleActionsPage.findNoticeText()
    expect(text).toContain("Couldn't start the tournament")
    expect(text).toContain('This tournament is already live.')
    // Not the edge the refetch moved on to.
    expect(text).not.toContain("Couldn't end the tournament")
    expectNoToast()
  })
})

/**
 * The standing refusal is about the last **attempt**, and opening or cancelling a dialog is
 * not one. A 409 on Start names the events whose draws are missing or stale — a work list
 * the director reads *while* going to fix it — so a second look at the confirm, thought
 * better of, must not take it away.
 */
describe('LifecycleActions · the refusal notice and the dialog', () => {
  it('keeps a standing refusal when the director opens the confirm and goes back', async () => {
    refuseTransition(409, NO_DRAW_FOR_OPEN_SINGLES)
    lifecycleActionsPage.render({
      tournament: buildTournament({ id: 't-1', status: 'published' }),
    })

    await userEvent.click(
      lifecycleActionsPage.getLifecycleButton(/Start tournament/),
    )
    await userEvent.click(lifecycleActionsPage.confirm.getConfirmButton())
    await lifecycleActionsPage.findNotice()

    // Second thoughts: open the question again, then go back.
    await userEvent.click(
      lifecycleActionsPage.getLifecycleButton(/Start tournament/),
    )
    await userEvent.click(lifecycleActionsPage.confirm.getCancelButton())
    await waitFor(() =>
      expect(lifecycleActionsPage.confirm.queryDialog()).toBeNull(),
    )

    // Still there — a cancel sent nothing, so it changed nothing, so it explains nothing
    // away. (Read by testid: while the dialog was up, Radix had this `aria-hidden`, and a
    // role query would have reported a standing notice as gone.)
    expect(lifecycleActionsPage.queryNoticeElement()).not.toBeNull()
    expect(await lifecycleActionsPage.findNoticeText()).toContain(
      '“Open Singles” has no draw yet',
    )
  })
})
