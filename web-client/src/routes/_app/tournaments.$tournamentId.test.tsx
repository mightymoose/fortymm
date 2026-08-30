import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import {
  buildTournamentDetailRead,
  buildTournamentEntrantRead,
  buildTournamentEventRead,
} from '@/mocks/factories/tournaments/tournament.factory'
import { mockUuid } from '@/mocks/mock-uuid'
import { server } from '@/mocks/server'
import { Route } from './tournaments.$tournamentId'

// The SHIPPED route options — read off the route rather than re-implemented, so a
// route that drops its `params.parse`, its `notFoundComponent` or its
// `errorComponent` reds these tests instead of quietly changing behaviour.
const TournamentRoute = Route.options.component!
const TournamentError = Route.options.errorComponent!
/** The route's OWN not-found boundary (ADR-1001). A route with none of its own has
 * no not-found boundary at its match at all, so the `notFound()` the query (or
 * `params.parse`) throws would escape to TanStack's generic screen — which is
 * exactly what these tests would then render, and go red on. */
const TournamentNotFound = Route.options.notFoundComponent
/** The REAL param parser, typed loosely enough to hang off this harness's route
 * (whose path type differs from the file route's). Nothing here re-implements it —
 * a route that dropped `params.parse` would send `/tournaments/abc` to the API. */
const shippedParseParams = (
  Route.options.params as { parse: (raw: unknown) => { tournamentId: string } }
).parse
/** The REAL search parser (`validateSearch: zodValidator(eventEditorSearchSchema)`),
 * likewise read off the shipped route rather than re-implemented here. It is what makes
 * a garbage `?event=` a URL that names nothing instead of a value the page has to
 * defend against (#1503, `.claude/rules/parse-at-boundaries.md`). */
const shippedValidateSearch = Route.options.validateSearch!

/** A well-formed uuid that names nothing — the "valid but unknown" case. */
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'

/** Count every detail fetch, so a test can prove one happened — or, for a
 * malformed id, that NONE did (the whole point of validating at the route
 * boundary: a garbage URL never reaches the API). */
function mockDetail(status: number, onRequest?: () => void) {
  server.use(
    http.get('*/v1/tournaments/:id', () => {
      onRequest?.()
      if (status === 200) return HttpResponse.json({ detail: 'unused' })
      return HttpResponse.json({ detail: 'nope' }, { status })
    }),
  )
}

/**
 * Mount the real route at its real path under a memory router, with the shipped
 * boundaries wired, plus a `/tournaments` list stub the not-found page's one
 * recovery link points at. `retryDelay: 1` keeps the 5xx-retry test fast (the
 * query's own `retry` predicate retries a 5xx twice, and it overrides the client).
 */
function renderRoute(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryDelay: 1 } },
  })
  const rootRoute = createRootRoute()
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tournaments/$tournamentId',
    component: TournamentRoute,
    errorComponent: TournamentError,
    notFoundComponent: TournamentNotFound,
    // The REAL param parser — the thing under test. A route that dropped it would
    // send `/tournaments/abc` to the API and blow up in the error boundary.
    params: { parse: (raw) => shippedParseParams(raw) },
    // …and the REAL search parser beside it. Without this the harness has no boundary
    // at all: a malformed `?event=` reaches the page verbatim, the editor stays closed
    // because no event MATCHES it rather than because the value was dropped, and the
    // refusal specs below pass against a route module with `validateSearch` deleted.
    // Measured: with it missing, `location.search` was `{ event: 'not-a-uuid' }`.
    validateSearch: shippedValidateSearch,
  })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tournaments',
    component: () => <div>tournaments list</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
    // Exposed so a test can force the background refetch every event mutation
    // (and the realtime feed) causes — the thing the open editor must survive.
    queryClient,
  }
}

describe('tournament detail route — a missing tournament is a not-found, not an error (ADR-1001)', () => {
  it('sends a MALFORMED id to the designed not-found — with no fetch and no validator string', async () => {
    // The #992 fix: `/tournaments/abc` must never reach the API (where it would
    // 422 with a Pydantic "Input should be a valid UUID" string) — `params.parse`
    // rejects the non-uuid segment and throws `notFound()` before any request.
    let requests = 0
    mockDetail(404, () => {
      requests += 1
    })

    renderRoute('/tournaments/abc')

    expect(
      await screen.findByRole('heading', { name: 'Tournament not found.' }),
    ).toBeInTheDocument()
    // Not a single fetch went out — the boundary caught it at the route edge.
    expect(requests).toBe(0)
    // And the raw validator string never appears.
    expect(screen.queryByText(/valid uuid/i)).not.toBeInTheDocument()
    // Not the error boundary, and not the generic router screen.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
  })

  it('sends a well-formed-but-unknown id (a 404) to the same not-found — and this one DID fetch', async () => {
    let requests = 0
    mockDetail(404, () => {
      requests += 1
    })

    renderRoute(`/tournaments/${UNKNOWN_ID}`)

    expect(
      await screen.findByRole('heading', { name: 'Tournament not found.' }),
    ).toBeInTheDocument()
    // The client cannot tell valid-unknown from valid-known without the request —
    // so unlike the malformed case, this one really asked the server. And exactly
    // ONCE: a 404 is terminal, so the query's `retry` predicate declines it rather
    // than making the user watch the skeleton through three attempts.
    expect(requests).toBe(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('is not a dead end — the one action lands on the tournaments list', async () => {
    const user = userEvent.setup()
    mockDetail(404)

    const { router } = renderRoute('/tournaments/abc')
    const link = await screen.findByRole('link', { name: 'Back to tournaments' })

    await user.click(link)

    expect(await screen.findByText('tournaments list')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/tournaments')
  })

  it('still sends a 5xx to the RETRYABLE error boundary — never “Tournament not found.”', async () => {
    // The regression this change most endangers: a server error is NOT a missing
    // tournament. It must render the error state, with a working retry, and must
    // never be reported as a 404.
    let requests = 0
    mockDetail(500, () => {
      requests += 1
    })

    renderRoute(`/tournaments/${UNKNOWN_ID}`)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t load this tournament.')
    expect(
      screen.queryByRole('heading', { name: 'Tournament not found.' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    // …and, unlike the 404, a 5xx is retried before it gives up (the query's
    // predicate retries a transient server failure a couple of times).
    expect(requests).toBeGreaterThan(1)
  })

  it('sends a 403 to the AccessDenied panel, not the not-found', async () => {
    // A permitted non-creator the server still gates. It used to reach the parent
    // layout's `RbacBoundary`; the route's own error boundary now catches it first
    // and renders the same panel.
    mockDetail(403)

    renderRoute(`/tournaments/${UNKNOWN_ID}`)

    expect(
      await screen.findByText("You don't have access to this page"),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Tournament not found.' }),
    ).not.toBeInTheDocument()
  })
})

// #1231 QA note: rapid clicks on the event editor's Create button created
// duplicate events in production. The fix (`EventEditor`'s `saving` prop, wired
// here as `savingEvent={createEvent.isPending || updateEvent.isPending}`) is
// covered by a PROP-CONTRACT test at `EventEditor` — see "the pending-mutation
// gate (#1231 QA)" in `event-editor.test.tsx`.
//
// A literal click-race reproduction was attempted here first and deliberately
// dropped: instrumenting the real commits showed the gap between React Hook
// Form's `isSubmitting` clearing and the mutation's own `isPending` clearing is
// real (confirmed on the committed DOM — the button was briefly present AND
// enabled while `open` was already `false`), but nothing in jsdom yields
// between those two commits — there is no paint/frame boundary the way a real
// browser has — so no `userEvent`/`fireEvent`/`waitFor`-driven double click
// could land inside it. Four independent reproduction shapes (simultaneous
// `userEvent.click`s, synchronous `fireEvent.click`s, a `waitFor`-timed second
// click on the re-enable edge, and a `MutationObserver`-driven catch) all
// produced exactly one POST under BOTH the fixed and the deliberately-broken
// (`savingEvent={false}`) wiring — i.e. a test built that way could not tell
// the two apart, so it would not have caught a regression. Reproducing the
// real animation-held window would need a Radix `Presence`/CSS-animation
// stand-in, which risks asserting a state the code path doesn't actually
// reach — see `.claude/rules/verify-the-artifact-under-test.md` on a red built
// from a fabricated setup proving nothing.

/**
 * **The open editor is a `?event=` search param** (#1503).
 *
 * These live at the ROUTE, not at `TournamentDetailPage`, because the claim is about
 * the URL: the route's `validateSearch` parses the value, the page resolves it, and
 * the editor's `useBlocker` guards the navigation that drops it. A component test
 * stands in for all three and would prove none of them.
 *
 * ⚠️ **What jsdom cannot prove here, and does not pretend to.** There is no Back
 * button in jsdom, and `@tanstack/history`'s blocked-pop path — the one that puts the
 * entry back so a second Back press asks again — only exists in a real session
 * history. Those live in `e2e/tournaments/event-editor-history.spec.ts`
 * (`.claude/rules/verify-the-artifact-under-test.md`).
 */
describe('tournament detail route — which event editor is open lives in the URL (#1503)', () => {
  /** A uuid that names an event of the served tournament. */
  const EVENT_ID = mockUuid('route-test-open-singles')
  /** …and one that names no event on it. */
  const OTHER_EVENT_ID = mockUuid('route-test-some-other-tournaments-event')

  /** Serve a real, parseable tournament, and count the detail fetches so a test can
   * prove a garbage `?event=` made none of its own. */
  function mockTournament(
    overrides: Parameters<typeof buildTournamentDetailRead>[0] = {},
    onRequest?: () => void,
  ) {
    server.use(
      http.get('*/v1/tournaments/:id', () => {
        onRequest?.()
        return HttpResponse.json(
          buildTournamentDetailRead({
            id: UNKNOWN_ID,
            events: [
              buildTournamentEventRead({
                id: EVENT_ID,
                tournament_id: UNKNOWN_ID,
                name: 'Open Singles',
              }),
            ],
            ...overrides,
          }),
        )
      }),
    )
  }

  const editorSheet = () => screen.queryByRole('dialog')
  const nameInput = () => screen.getByLabelText(/Event name/)
  const discardDialog = () => screen.queryByTestId('discard-event-edits')

  it('opens the named event on FIRST RENDER — a deep link, not a click', async () => {
    mockTournament()

    renderRoute(`/tournaments/${UNKNOWN_ID}?event=${EVENT_ID}`)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(nameInput()).toHaveValue('Open Singles')
  })

  it('opens the UNSAVED editor for `?event=new`', async () => {
    mockTournament()

    renderRoute(`/tournaments/${UNKNOWN_ID}?event=new`)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByTestId('event-editor-overline')).toHaveTextContent(
      'New event',
    )
  })

  it('leaves the editor CLOSED for `?event=new` when the viewer cannot edit', async () => {
    // A read-only sheet over an event that does not exist is not a state the product
    // has (ADR-0015: read-only is a view, and there is nothing here to view).
    mockTournament({ can_edit: false })

    renderRoute(`/tournaments/${UNKNOWN_ID}?event=new`)

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(editorSheet()).not.toBeInTheDocument()
  })

  // Two different refusals, and the page's answer is the same for both: a well-formed
  // uuid survives the boundary and is refused later, by resolution against THIS
  // tournament's events; a value that is neither a uuid nor `new` never gets that far,
  // because `validateSearch` drops it. Which refusal fired is not observable from here
  // — `location.search` is the raw query object, not the validator's output — so the
  // boundary's own half is pinned directly, in `data/event-editor-search.test.ts`.
  it.each([
    ['a uuid naming no event on this tournament', OTHER_EVENT_ID],
    ['a value that is neither a uuid nor `new`', 'not-a-uuid'],
    ['an empty value', ''],
  ])('leaves the editor closed for %s — and makes no extra request', async (_label, value) => {
    let requests = 0
    mockTournament({}, () => {
      requests += 1
    })

    renderRoute(`/tournaments/${UNKNOWN_ID}?event=${value}`)

    // The page renders exactly as it does without the param…
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(editorSheet()).not.toBeInTheDocument()
    // …no error boundary, no not-found…
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Tournament not found.' }),
    ).not.toBeInTheDocument()
    // …and the only fetch was the tournament's own. A URL that names no resource is
    // never a request to make (ADR-1001).
    expect(requests).toBe(1)
  })

  it('closes a CLEAN editor with no confirmation, and drops the param', async () => {
    const user = userEvent.setup()
    mockTournament()

    const { router } = renderRoute(`/tournaments/${UNKNOWN_ID}?event=${EVENT_ID}`)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(editorSheet()).not.toBeInTheDocument())
    expect(discardDialog()).not.toBeInTheDocument()
    expect(router.state.location.search).toEqual({})
  })

  it('asks before discarding a DIRTY editor, and keeps everything when told to stay', async () => {
    const user = userEvent.setup()
    mockTournament()

    const { router } = renderRoute(`/tournaments/${UNKNOWN_ID}?event=${EVENT_ID}`)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.clear(nameInput())
    await user.type(nameInput(), 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(await screen.findByTestId('discard-event-edits')).toBeInTheDocument()
    // Nothing has closed and nothing has navigated while the question is open.
    // Read by TEST ID, not by role: the `AlertDialog` on top is modal, so Radix
    // `aria-hidden`s the rest of the document and a role query cannot see the sheet
    // underneath it — which would read as "the editor closed".
    expect(screen.queryByTestId('event-editor-body')).toBeInTheDocument()
    expect(router.state.location.search).toEqual({ event: EVENT_ID })

    await user.click(screen.getByRole('button', { name: 'Keep editing' }))

    await waitFor(() => expect(discardDialog()).not.toBeInTheDocument())
    expect(editorSheet()).toBeInTheDocument()
    // The param is still there — which is what makes a second attempt ask again
    // rather than leaving the page with the sheet open.
    expect(router.state.location.search).toEqual({ event: EVENT_ID })
    expect(nameInput()).toHaveValue('Renamed')
  })

  it('discards on request — the sheet goes and the param goes with it', async () => {
    const user = userEvent.setup()
    mockTournament()

    const { router } = renderRoute(`/tournaments/${UNKNOWN_ID}?event=${EVENT_ID}`)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.clear(nameInput())
    await user.type(nameInput(), 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(
      await screen.findByRole('button', { name: 'Discard & leave' }),
    )

    await waitFor(() => expect(editorSheet()).not.toBeInTheDocument())
    expect(router.state.location.search).toEqual({})
  })

  it('counts a field typed and typed BACK as clean — no confirmation', async () => {
    // React Hook Form compares against `defaultValues`, so an edit that was undone
    // is not an edit. The dirty predicate is the whole of the guard's arming
    // condition, and a guard that fires over nothing is one people click through.
    const user = userEvent.setup()
    mockTournament()

    renderRoute(`/tournaments/${UNKNOWN_ID}?event=${EVENT_ID}`)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.type(nameInput(), '!')
    await user.type(nameInput(), '{backspace}')
    expect(nameInput()).toHaveValue('Open Singles')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(editorSheet()).not.toBeInTheDocument())
    expect(discardDialog()).not.toBeInTheDocument()
  })

  it('never asks a READER anything — Done closes silently', async () => {
    const user = userEvent.setup()
    mockTournament({ can_edit: false })

    renderRoute(`/tournaments/${UNKNOWN_ID}?event=${EVENT_ID}`)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => expect(editorSheet()).not.toBeInTheDocument())
    expect(discardDialog()).not.toBeInTheDocument()
  })

  it('re-seeds on every open — a second open never inherits the first draft', async () => {
    // The trap the URL introduces: the page resolves `?event=` to an event of the
    // tournament and holds it, so re-opening the same event hands the editor the very
    // same object. Keyed on identity alone the draft would survive — and its dirty
    // flag with it, arming the discard guard over work nobody typed this time.
    const user = userEvent.setup()
    mockTournament()

    renderRoute(`/tournaments/${UNKNOWN_ID}?event=${EVENT_ID}`)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.clear(nameInput())
    await user.type(nameInput(), 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(
      await screen.findByRole('button', { name: 'Discard & leave' }),
    )
    await waitFor(() => expect(editorSheet()).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Edit Open Singles' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(nameInput()).toHaveValue('Open Singles')
    // …and it is CLEAN: closing it asks nothing.
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(editorSheet()).not.toBeInTheDocument())
    expect(discardDialog()).not.toBeInTheDocument()
  })

  it('closes a SAVED event with no confirmation, though the draft is still dirty', async () => {
    // The form is not re-seeded until the refetched event arrives, so `isDirty` is
    // still true at close time. An unguarded close would confirm on every save —
    // a prompt on the happy path.
    const user = userEvent.setup()
    mockTournament()
    server.use(
      http.patch('*/v1/tournaments/:id/events/:eventId', () =>
        HttpResponse.json(
          buildTournamentEventRead({
            id: EVENT_ID,
            tournament_id: UNKNOWN_ID,
            name: 'Renamed',
          }),
        ),
      ),
    )

    const { router } = renderRoute(`/tournaments/${UNKNOWN_ID}?event=${EVENT_ID}`)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.clear(nameInput())
    await user.type(nameInput(), 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    // By TEST ID: a confirmation on top would `aria-hidden` the sheet, so a role
    // query would report it "closed" while it is still there — the assertion would
    // then pass against the very bug it is here to catch.
    await waitFor(() =>
      expect(screen.queryByTestId('event-editor-body')).not.toBeInTheDocument(),
    )
    expect(discardDialog()).not.toBeInTheDocument()
    expect(router.state.location.search).toEqual({})
  })

  it('survives a background refetch that CHANGES the open event, with the draft intact', async () => {
    // Every event mutation invalidates the tournament, and the realtime feed does too,
    // so a refetch under an open editor is ordinary. Resolving `?event=` against
    // `tournament.events` on every render would hand the editor a new object whenever
    // one came back — and `EventEditor` re-seeds its form on that object's identity,
    // wiping the director's typing while they were typing it.
    //
    // ⚠️ The refetched event must really have CHANGED. React Query applies structural
    // sharing, so a byte-identical payload comes back as the very same object and the
    // re-seed never fires — a test built on an unchanged refetch passes against the
    // naive implementation too, and proves nothing
    // (`.claude/rules/verify-the-artifact-under-test.md`). Somebody entering the event
    // is the ordinary way this happens.
    const user = userEvent.setup()
    let entrants: ReturnType<typeof buildTournamentEntrantRead>[] = []
    let requests = 0
    server.use(
      http.get('*/v1/tournaments/:id', () => {
        requests += 1
        return HttpResponse.json(
          buildTournamentDetailRead({
            id: UNKNOWN_ID,
            events: [
              buildTournamentEventRead({
                id: EVENT_ID,
                tournament_id: UNKNOWN_ID,
                name: 'Open Singles',
                entrants,
              }),
            ],
          }),
        )
      }),
    )

    const { queryClient } = renderRoute(
      `/tournaments/${UNKNOWN_ID}?event=${EVENT_ID}`,
    )
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.clear(nameInput())
    await user.type(nameInput(), 'Half-typed name')

    // Somebody enters the event, and the tournament is refetched under the open sheet.
    entrants = [buildTournamentEntrantRead()]
    const before = requests
    await act(async () => {
      await queryClient.invalidateQueries()
    })
    await waitFor(() => expect(requests).toBeGreaterThan(before))

    // The changed payload landed and the draft is untouched.
    expect(nameInput()).toHaveValue('Half-typed name')
  })

  it('deletes without stacking a discard confirmation on the delete confirmation', async () => {
    // `onDelete` closes the editor BEFORE raising the delete confirmation. Asking the
    // director to protect edits they have just asked to delete the event holding is a
    // second dialog over the first, and the answer to one is not the answer to both.
    const user = userEvent.setup()
    mockTournament()

    renderRoute(`/tournaments/${UNKNOWN_ID}?event=${EVENT_ID}`)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.clear(nameInput())
    await user.type(nameInput(), 'About to be deleted')
    await user.click(screen.getByRole('button', { name: 'Delete event' }))

    // The delete confirmation, and only it.
    expect(await screen.findByText('Delete event?')).toBeInTheDocument()
    expect(discardDialog()).not.toBeInTheDocument()
  })
})

/**
 * **The Details save is a promise, not a fire-and-forget** (#1593).
 *
 * These live at the ROUTE because the claim is about the WIRING: the route's
 * `onUpdate` must `await` `mutateAsync` and hand the rejection to `DetailsTab`,
 * which words it inline. The predecessor shape — `mutate(...)` with the rejection
 * left to a global toast — is exactly what a component test cannot see: the prop
 * spy resolves just the same. A refused PATCH here is the only assertion that
 * cannot pass while the promise is swallowed on the way from the route to the
 * form.
 */
describe('tournament detail route — a refused Details save is reported inline (#1593)', () => {
  /** What FastAPI really answers an over-long name with — the string that must
   * never reach the UI (ADR-0968, `DEFINITION_OF_COMPLETE.md`). */
  const PYDANTIC = 'String should have at most 255 characters'

  /** Serve a real, parseable, editable tournament (the creator's view). */
  function mockEditableTournament() {
    server.use(
      http.get('*/v1/tournaments/:id', () =>
        HttpResponse.json(buildTournamentDetailRead({ id: UNKNOWN_ID })),
      ),
    )
  }

  it('carries a PATCH rejection to the Details form, which words it itself', async () => {
    const user = userEvent.setup()
    mockEditableTournament()
    let patches = 0
    server.use(
      http.patch('*/v1/tournaments/:id', () => {
        patches += 1
        return HttpResponse.json(
          {
            detail: [
              { type: 'string_too_long', loc: ['body', 'name'], msg: PYDANTIC },
            ],
          },
          { status: 422 },
        )
      }),
    )

    renderRoute(`/tournaments/${UNKNOWN_ID}`)
    await screen.findByRole('heading', { level: 1 })

    await user.click(screen.getByRole('tab', { name: 'Details' }))
    await user.type(screen.getByLabelText(/Name/), '!')
    await user.click(screen.getByRole('button', { name: /Save changes/ }))

    // The client-owned sentence, under the box the server blamed — and never
    // the wire's own prose.
    expect(
      await screen.findByText(
        'The Name was rejected. Check that field and try again.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(PYDANTIC)).not.toBeInTheDocument()
    // The form-level alert stays out of it: this refusal was attributed.
    expect(screen.queryByTestId('details-save-error')).not.toBeInTheDocument()
    expect(patches).toBe(1)
  })
})
