import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockTournamentTransitionEndpoint } from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentDetailRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { waitFor } from '@/test/utilities'

import { buildTournament } from '../data/seed.factory'
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

/** Click **Start tournament** on a published tournament the viewer owns — the one edge
 * that carries a precondition (ADR-0786). */
async function clickStart() {
  lifecycleActionsPage.render({
    tournament: buildTournament({ id: 't-1', status: 'published' }),
  })
  await userEvent.click(lifecycleActionsPage.getLifecycleButton(/Start tournament/))
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

    await waitFor(() =>
      expect(lifecycleActionsPage.queryNotice()).toBeNull(),
    )
  })
})
