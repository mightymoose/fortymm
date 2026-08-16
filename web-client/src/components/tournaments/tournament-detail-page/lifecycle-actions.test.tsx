import userEvent from '@testing-library/user-event'
import { delay, HttpResponse } from 'msw'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockTournamentTransitionEndpoint } from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentDetailRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { waitFor } from '@/test/utilities'

import {
  buildEvent,
  buildScheduleSolve,
  buildTournament,
} from '../data/seed.factory'
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
 * opens the confirm and the confirm's own button is what posts. */
async function clickStart() {
  lifecycleActionsPage.render({
    tournament: buildTournament({ id: 't-1', status: 'published' }),
  })
  await userEvent.click(lifecycleActionsPage.getLifecycleButton(/Start tournament/))
  await userEvent.click(lifecycleActionsPage.confirm.getConfirmButton())
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
describe('LifecycleActions · a refused Start tournament (409)', () => {
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
  const TWO_EVENTS =
    'This tournament cannot start yet: “Under 1200” has no draw yet; and “Over 40s” ' +
    'has a draw that no longer matches its entrants. A draw is cut from the field as ' +
    'it stands at the time, and registration stays open right up to the moment a ' +
    'tournament goes live — so cut the draw for each event named (again, if somebody ' +
    'entered or withdrew since it was last cut), then start the tournament.'
  // The two shapes #1300 added, and they are LONGER than the four above for a reason: an
  // event no cut could ever fix carries its own reason and its own fix, so there is no
  // shared clause to fold it into. Both are the API's composed sentence, verbatim.
  const ALL_UNDRAWABLE =
    'This tournament cannot start yet: “Doubles Event”: A doubles event cannot be ' +
    'given a draw — only singles events can. A fixture seats one entrant on each side, ' +
    'and there is nowhere to record a doubles pairing or a team. Remove the event. ' +
    '“Lone Event”: A single-elimination draw needs at least 2 entrants — a bracket of ' +
    'one has nobody to play. Add entrants, or remove the event.'
  // Undrawable first, so "cut the draw for each event named" trails only the names a cut
  // would actually fix — the other order walked QA's director into a refused cut (#1300).
  const MIXED =
    'This tournament cannot start yet: “A Undrawable”: 1 entrant across 1 pool would ' +
    'leave a pool with fewer than 2 entrants, who would have nobody to play. Add ' +
    'entrants, or remove the event. “B Uncut” has no draw yet; and “C Stale” has a ' +
    'draw that no longer matches its entrants. A draw is cut from the field as it ' +
    'stands at the time, and registration stays open right up to the moment a ' +
    'tournament goes live — so cut the draw for each event named (again, if somebody ' +
    'entered or withdrew since it was last cut), then start the tournament.'

  // Each refusal renders — and renders the SERVER's sentence, which is the only half that
  // says what to go and do. The assertions name the *events*, because a test that
  // asserted merely "an error is shown" would pass just as happily against a generic
  // "something went wrong".
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
    {
      name: 'every at-fault event undrawable (#1300)',
      detail: ALL_UNDRAWABLE,
      names: ['“Doubles Event”', '“Lone Event”'],
    },
    {
      name: 'an undrawable, an uncut and a stale event at once (#1300)',
      detail: MIXED,
      names: ['“A Undrawable”', '“B Uncut”', '“C Stale”'],
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

  /**
   * The acceptance criterion of #1300, asserted on the rendered notice rather than on the
   * string: when every at-fault event is undrawable, the director must not be sent to cut
   * a draw.
   *
   * It reads as an ABSENCE on purpose. The `toContain(detail)` above is satisfied by any
   * notice that carries the whole sentence, and would be equally satisfied by a component
   * that decided to append a helpful "…so cut the draw for each event named" of its own —
   * which is the exact instruction this refusal exists to withhold.
   */
  it('shows no cut-the-draw instruction when every at-fault event is undrawable', async () => {
    refuseTransition(409, ALL_UNDRAWABLE)

    await clickStart()

    const text = await lifecycleActionsPage.findNoticeText()
    expect(text).toContain('Remove the event.')
    expect(text).not.toContain('cut the draw')
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

/**
 * A refusal is a statement about a **moment** (#1049 repro A, #1216).
 *
 * The header's notice used to be cleared only by the *next* attempt, so a director who
 * read "This tournament has no events, so there is nothing to start" and then went and
 * added one was left with the header contradicting the page below it — the refusal above,
 * **1 EVENTS** beneath. Only a reload, or another Start click, cleared it.
 *
 * The pair below is the whole design, and the second half is what makes it a design: it
 * must clear when the director fixes what it named, and it must NOT clear for anything
 * else. This page polls, and the 409's sentence is a work list the director reads *while*
 * going to fix it — a notice that blinked out on a solve tick would be worse than the
 * stale one it replaced.
 */
describe('LifecycleActions · a refusal does not outlive the state it describes', () => {
  const NOTHING_TO_START =
    'This tournament has no events, so there is nothing to start. Add an event and cut ' +
    'its draw, then start the tournament.'

  /** A published tournament with **nothing to start** — the state the 409 is about. */
  const EMPTY = buildTournament({ id: 't-1', status: 'published', events: [] })

  /** Get the no-events refusal onto the screen, and hand back the render handle so the
   * test can move the world underneath it. */
  async function refusedStart() {
    mockTournamentTransitionEndpoint(server, () =>
      HttpResponse.json({ detail: NOTHING_TO_START }, { status: 409 }),
    )
    const utils = lifecycleActionsPage.render({ tournament: EMPTY })
    await userEvent.click(
      lifecycleActionsPage.getLifecycleButton(/Start tournament/),
    )
    await userEvent.click(lifecycleActionsPage.confirm.getConfirmButton())
    // The refusal is up before anything is asserted about it going away.
    expect(await lifecycleActionsPage.findNoticeText()).toContain(
      'no events, so there is nothing to start',
    )
    return utils
  }

  it('clears the "no events" refusal once an event is added', async () => {
    const { rerenderWith } = await refusedStart()

    rerenderWith({ tournament: { ...EMPTY, events: [buildEvent()] } })

    expect(lifecycleActionsPage.queryNoticeElement()).toBeNull()
  })

  /**
   * The discriminating half. A blunt "clear whenever the tournament object changed"
   * passes the test above just as happily as the narrow scope does — and then throws the
   * director's work list away on the next poll. Here the tournament genuinely changes, in
   * a way no lifecycle refusal has ever asserted anything about, and the sentence must
   * survive it.
   */
  it('keeps the refusal through a change it says nothing about', async () => {
    const { rerenderWith } = await refusedStart()

    rerenderWith({
      tournament: {
        ...EMPTY,
        latestScheduleSolve: buildScheduleSolve(),
        name: 'Bay Area Open 2026 (renamed)',
        description: 'Reworded while the director read the refusal.',
      },
    })

    expect(lifecycleActionsPage.queryNoticeElement()).not.toBeNull()
    expect(await lifecycleActionsPage.findNoticeText()).toContain(
      'no events, so there is nothing to start',
    )
  })

  /** A refetch that changed nothing at all is the commonest render of the three, and the
   * one an object-identity check would fail: TanStack Query hands back a new object every
   * poll even when the data is equal. */
  it('keeps the refusal through a refetch that changed nothing', async () => {
    const { rerenderWith } = await refusedStart()

    rerenderWith({ tournament: { ...EMPTY } })

    expect(lifecycleActionsPage.queryNoticeElement()).not.toBeNull()
  })

  /**
   * The **stale tab**, and the case that says the status must stay out of the scope.
   *
   * The director published from their phone; this page still shows a draft. They click
   * Publish, and the server answers "This tournament is already published." The mutation
   * reconciles on settle, so the badge and button correct themselves from Draft/Publish
   * to Published/Start — *under* the notice.
   *
   * The status changing is not evidence the refusal went stale. It is the refusal coming
   * true, and the notice is the only account the director gets of why their click did
   * nothing. Retiring it here would remove the explanation at the exact moment the page
   * does the thing that needs explaining. (`tournament-lifecycle.spec.ts` asserts the same
   * behaviour end-to-end; this is the fast twin, so a regression reds in vitest too.)
   */
  it('keeps a stale-tab refusal while the view corrects itself around it', async () => {
    const STALE = buildTournament({ id: 't-1', status: 'draft' })
    mockTournamentTransitionEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'This tournament is already published.' },
        { status: 409 },
      ),
    )
    const { rerenderWith } = lifecycleActionsPage.render({ tournament: STALE })
    await userEvent.click(lifecycleActionsPage.getLifecycleButton(/Publish/))
    await userEvent.click(lifecycleActionsPage.confirm.getConfirmButton())
    expect(await lifecycleActionsPage.findNoticeText()).toContain(
      'already published',
    )

    // The reconciling refetch lands: this page now agrees with the server.
    rerenderWith({ tournament: { ...STALE, status: 'published' } })

    // The button has moved on to the next edge — and the explanation is still there.
    expect(
      lifecycleActionsPage.queryLifecycleButton(/Start tournament/),
    ).toBeInTheDocument()
    expect(lifecycleActionsPage.queryNoticeElement()).not.toBeNull()
    expect(await lifecycleActionsPage.findNoticeText()).toContain(
      'already published',
    )
  })
})
