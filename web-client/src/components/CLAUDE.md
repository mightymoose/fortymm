# Component conventions

This codifies the pattern established by the **match-details scoreboard** refactor. The
scoreboard subtree is the reference implementation — when in doubt, open it and copy its
shape:

```
matches/match-details/scoreboard/
```

Build new feature surfaces this way. The two things being replaced —
`matches/match-details/match-details.tsx` (the `projectMatchView` / `MatchView`
god-object) and `scoreboard-old.tsx` — are the *old* pattern. Don't extend them or copy
their style.

---

## The shape

A component `X` is a folder of small files with fixed roles. Children that have children
of their own get a sibling folder named after the parent, so the **path mirrors the render
tree**:

| file              | role                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| `x.tsx`           | the component — **pure**, unless it's the single data node (see below)        |
| `x-query.tsx`     | *(data node only)* query factory: shared base query + `select` projection + view-model types |
| `x-skeleton.tsx`  | the `<Suspense>` fallback; mirrors `x`'s layout exactly                        |
| `x.factory.ts`    | builds `x`'s props with overridable defaults                                  |
| `x.page.tsx`      | **page object** — the only surface tests touch the DOM through                |
| `x.test.tsx`      | the test — imports the page object + factory, nothing else                    |

The reference slice, annotated with purity (`◆` = the one impure node):

```
Scoreboard(matchId)                        scoreboard.tsx                pure shell (Card)
├─ Header(matchId)                         scoreboard/header.tsx         pure — <Suspense fallback={<HeaderSkeleton/>}>
│  └─ HeaderData(matchId)                  header/header-data.tsx        ◆ useSuspenseQuery → hand off. Nothing else.
│     └─ MatchHeaderDataDisplay(data)      header-data/header-data-display.tsx   pure composition
│        ├─ Meta(status,bestOf)            …/meta.tsx                    pure leaf
│        └─ MatchScore(sides,games,bestOf) …/match-score.tsx            pure — branches Upcoming / Played
└─ LineScore(matchId)                      scoreboard/line-score.tsx     pure — <Suspense fallback={<LineScoreSkeleton/>}>
   └─ LineScoreData(matchId)               line-score/line-score-data.tsx        ◆ useSuspenseQuery → hand off
      └─ LineScoreDataDisplay(data)        …/line-score-data-display.tsx pure composition
         └─ LineScoreGrid + Line[]         …/line.tsx                    pure leaves
```

Keep components **small**. A file does one thing: load, compose, or render a leaf. If a
component is doing two of those, split it.

---

## Purity: one data node per subtree

A subtree has **exactly one impure component** — the `*-data.tsx` node. Its entire body is
a suspense query and a hand-off:

```tsx
// header-data.tsx — the whole component
export const HeaderData = ({ matchId }: HeaderDataProps) => {
  const { data } = useSuspenseQuery(headerDataQuery(matchId))
  return <MatchHeaderDataDisplay matchHeaderData={data} />
}
```

It does **nothing else** — no formatting, no derived state, no conditionals. Everything
below it is a pure function of props. If you reach for `useQuery`, `useEffect`, `fetch`, or
`useState`-for-data anywhere but a data node, you're in the wrong file.

**Projection lives in the query's `select`, not the component.** `*-query.tsx` spreads the
shared base query and adds a `select` built from small pure `toX` helpers, and it owns the
view-model types:

```tsx
// header-data-query.tsx
export type HeaderSide = { id: string; username: string }
export type GameScore = { sideNumber: number; points: number }

export const headerDataQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: (data: MatchDetails) => ({
    status: toStatusView(data),   // pure helpers, same file
    bestOf: data.best_of,
    sides: toSides(data),
    games: toGames(data),
  }),
})
```

View-model types are single-source: sibling sections **re-export** them rather than
redefining (`line-score-data-query.tsx` re-exports `GameScore` / `HeaderSide` from the
header query).

---

## Data loading: one fetch, many `select`s

Every section reads the **same** base query — `matchDetailsQuery(matchId)`, key
`['matches','detail',matchId]` (`matches/match-details/match-details-query.ts`). Multiple
`useSuspenseQuery` calls with that key **dedupe to a single network request**; each section
supplies its own `select` to project just the slice it needs. Adding a section means a new
`*-query.tsx` with a new `select` — **not** a new endpoint (the BFF returns one
page-shaped payload; see `web-client/CLAUDE.md` and the repo BFF rule).

The route warms this query in its `loader` via `queryClient.ensureQueryData(...)`
(`routes/_authenticated/matches/$matchId.tsx`), so sections resolve from cache. They still
declare their **own** `<Suspense>` boundary so each can pop in independently and stays
self-contained and testable.

The wrapper component is pure and tiny — just the boundary:

```tsx
// header.tsx
export function Header({ matchId }: HeaderProps) {
  return (
    <Suspense fallback={<HeaderSkeleton />}>
      <HeaderData matchId={matchId} />
    </Suspense>
  )
}
```

---

## Loading: skeletons that don't shift

Every `<Suspense>` fallback is a dedicated `*-skeleton.tsx` that **mirrors the real layout**
so nothing reflows when data swaps in.

- **Compose from per-part skeletons that live beside their real component**:
  `meta-skeleton.tsx` next to `meta.tsx`, `match-score-skeleton.tsx` next to
  `match-score.tsx`, `line-skeleton.tsx` next to `line.tsx`. `HeaderSkeleton` is just
  `<MetaSkeleton/> + <MatchScoreSkeleton/>`, mirroring `MatchHeaderDataDisplay`.
- **Reserve identical space** by reusing the real layout primitives and class names — this
  is the whole point. Examples to copy:
  - `MatchScoreSkeleton` reuses the real `md-hero__row` grid and the shared `MatchScoreSlot`
    (whose hidden `0` sizer keeps the score height reserved).
  - `LineSkeleton`'s cell is `h-[22px]` to match a real score's 22px line height.
  - `LineScoreSkeleton` reuses `LineScoreGrid` itself — 3 placeholder columns and
    `showGameLabels={false}`, since the real game count isn't known yet.
- Mark the skeleton root `aria-busy="true"` + a `data-testid` so its page object can assert
  the busy state.

---

## Errors: handle them once, at the route

There are **no error boundaries inside this subtree, on purpose**. The only failure that
matters is "the match didn't load," and there's no partial state worth recovering — the
page loads or it doesn't. So:

- `matchDetailsQuery` sets `retry: false` + `throwOnError: true`, letting a failure bubble.
- The **route** owns the boundary: `errorComponent: MatchDetailsErrorRoute`
  (`routes/_authenticated/matches/$matchId.tsx`) maps 404 → `MatchNotFound`, re-throws the
  rest.

Add an `ErrorBoundary` inside a subtree **only** when a section can fail independently while
the rest of the page stays useful. Don't add one reflexively.

---

## Factories: two tiers

Build test data from factories — never hand-write object literals in a test. Which factory
depends on what you're building:

- **Wire / endpoint shape** → the **global** factory in `@/test/factories`
  (`matchDetails(overrides)`), typed to the OpenAPI schema
  (`components['schemas']['MatchDetails']`). This is the BFF payload; use it whenever you
  stub the endpoint.
- **Component props / view-models** → a **local** `*.factory.ts` beside the component, typed
  to the component's own props (`Partial<MetaProps>`, `Partial<LineProps>`, …).

Rules:

- Defaults are the common case; everything is overridable via one `overrides` arg merged
  last: `({ ...defaults, ...overrides })`.
- **Encode intent with named helpers; randomise "don't care".** `gameWonBy(sideNumber)`
  randomises the loser's points (faker) to signal they don't matter; `game(a, b)` sets exact
  cells; `headerSideFactory()` faker-fills `id`/`username`. See `match-score.factory.ts` and
  `line.factory.ts`.

---

## Page objects: the only way tests touch the DOM

Tests **never** query the DOM directly — only through a page object. Each `x.page.tsx`
exports `xPage` with `render(props)` and **semantic getters** that hide selectors:

```tsx
// meta.page.tsx
export const metaPage = {
  render(props: MetaProps) { render(<Meta {...props} />) },
  get status()  { return document.querySelector('[data-slot="badge"]')?.textContent?.trim() ?? null },
  get format()  { return screen.getByText(/SINGLES · BO\d+/).textContent },
  get firstTo() { /* parse "First to N" → number | null */ },
}
```

**Compose, don't restate.** A parent page object reuses its children's:

```tsx
// header-data-display.page.tsx
export const matchHeaderDataDisplayPage = {
  render(props) { render(<MatchHeaderDataDisplay {...props} />) },
  meta: metaPage,            // reads go through the children's own objects
  score: matchScorePage,
}
```

`matchScorePage.forPlayer` *is* `playedMatchScorePage.forPlayer`; `playerScorePage.within(el)`
is reused to read individual cells inside `linePage.game(username, n)`. Read through the same
objects the children's own tests use.

**Data-node page objects** own the endpoint + lifecycle, and *still* read through the leaf
page objects — so a data-node test exercises the real `select` projection end-to-end:

```tsx
// header-data.page.tsx
export const headerDataPage = {
  // Owns method + path; callers pass only the resolver, so the route string lives once.
  mockEndpoint(resolver: HttpResponseResolver) {
    server.use(http.get("*/v1/matches/:matchId", resolver))
  },
  render(matchId: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={<div data-testid="header-data-loading" />}>
          <HeaderData matchId={matchId} />
        </Suspense>
      </QueryClientProvider>,
    )
  },
  get isLoading() { return screen.queryByTestId("header-data-loading") !== null },
  // settle() awaits a marker ONLY the loaded UI renders — never the skeleton.
  settle() { return screen.findByRole("group", { name: "Match score" }) },
  meta: metaPage,
  score: matchScorePage,
}
```

Notes:
- Each render builds a **fresh `QueryClient` with `retry: false`**.
- The data-node page object isolates the node with a **bare `data-testid` fallback**; the
  *real* skeleton is tested via the wrapper page object.
- `settle()` must wait on something the skeleton does **not** render — header uses the
  `role="group" name="Match score"` strip; line score uses `findByText("G1")` because the
  skeleton renders the grid but no column labels.
- The wrapper page object stitches them together:
  `headerPage = { mockEndpoint: headerDataPage.mockEndpoint, skeleton: headerSkeletonPage, data: headerDataPage }`.

---

## Mocking endpoints

- The global MSW server (`@/mocks/server`) is started by `src/test/setup.ts` with
  `onUnhandledRequest: 'error'` — **every** request needs a handler. The default
  `GET */v1/matches/:matchId` lives in `src/mocks/handlers.ts` (mock store +
  `projectMatchDetails`).
- **Per test, override with `server.use(...)` — always via the page object's
  `mockEndpoint`**, so the route string is defined in exactly one place. Shape the response
  per test:
  - `HttpResponse.json(matchDetails({ status: "completed", ... }))` for a specific case,
  - `await delay(ms)` before responding to hold the skeleton on screen,
  - return an error status to drive the failure path.
- **Wildcard the host** (`"*/v1/matches/:matchId"`) — the base URL varies (MSW dev vs the
  compose stack).

---

## Tests: putting it together

- **Pure component** — feed the local prop factory, assert via getters:
  ```tsx
  matchHeaderDataDisplayPage.render(matchHeaderDataDisplayFactory({ bestOf: 7 }))
  expect(matchHeaderDataDisplayPage.meta.format).toBe("SINGLES · BO7")
  ```
- **Data node** — stub the endpoint with the *global* `matchDetails` factory, settle, then
  assert through the reused leaf getters (this is where the `select` projection is covered):
  ```tsx
  headerDataPage.mockEndpoint(() => HttpResponse.json(matchDetails({ status: "in_progress", ... })))
  headerDataPage.render(match.id)
  await headerDataPage.settle()
  expect(headerDataPage.meta.status).toBe("Live · Game 3")
  ```
  `header-data.test.tsx` is the worked example: status→badge mapping, side ordering, dropped
  unscored games, the no-opponent sentinel.
- **Loading / swap** — `delay` the response, assert `skeleton.isBusy`, `await data.settle()`,
  assert the loaded state (`header.test.tsx`).

---

## Checklist for a new component

1. `x.tsx` — pure. If it needs data, it's a `<Suspense>` wrapper around `x-data.tsx`.
2. Needs data? → `x-data.tsx` (only `useSuspenseQuery` + hand-off) + `x-query.tsx`
   (`select` + view-model types, reusing the shared base query) + `x-skeleton.tsx`.
3. `x.factory.ts` for props — or extend `@/test/factories` if it's a wire shape.
4. `x.page.tsx` — semantic getters; reuse children's page objects.
5. `x.test.tsx` — through the page object only.
6. Children that have children get a sibling `x/` folder. Recurse.
