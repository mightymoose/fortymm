# web-client

## Architecture

**Routing is file-based and generated.** `src/routes/*.tsx` files are compiled
into `routeTree.gen.ts` by the `@tanstack/router-plugin/vite` plugin. Don't
edit `routeTree.gen.ts` by hand.

**MSW only intercepts in `import.meta.env.DEV`.** See `src/main.tsx` (and the
`VITE_ENABLE_MSW=false` escape hatch for hitting a real API). The vitest setup
(`src/test/setup.ts`) uses the Node MSW server with
`onUnhandledRequest: 'error'` — every fetch in a test must have a matching
handler in `src/mocks/handlers.ts` (or one added via `server.use(...)`).
Production builds never load MSW.

**`VITE_API_URL`** overrides the API base URL; otherwise the client uses
`window.location.origin`. In dev that means MSW handles everything; in the
compose stack the web origin is also where nginx proxies the API.

## Testing

Two layers, mocked two different ways — don't confuse them:

- **vitest** (`npm run test:run`, jsdom) mocks the network with **MSW**
  (`onUnhandledRequest: 'error'`). This is the fast inner loop.
- **`web-client/e2e/`** (`npm run test:e2e`, Playwright) runs with **MSW OFF**
  and stubs the network via inline Playwright `page.route` interceptors. vitest
  will NOT catch a mismatch here: when a BFF endpoint or the API schema changes,
  you must update the affected `page.route` stubs and run the e2e suite, or it
  goes green in vitest and breaks in e2e. (The **root `e2e/`** suite is a
  separate, full-stack thing — not this one.)
- **Screenshot baselines** are committed for both darwin and chromium-linux
  (e.g. `*-chromium-linux.png`). Regenerate the linux baselines with the
  `mcr.microsoft.com/playwright` docker image so CI (linux) doesn't churn.

Reach for the `react-component` skill (component + page-object + factory + vitest
quartet) and the `fetching-data` skill (TanStack Query `queryOptions` factories)
for the file-layout conventions — they're not otherwise written down here.

### `throwOnError` also throws on a *background* refetch

React Query v5 sets `status: 'error'` on a failed refetch **even when data is
already cached** (the reducer's `error` case is unconditional), and
`getHasError` (`react-query/errorBoundaryUtils`) throws during render whenever
`isError && !isFetching && throwOnError`. So `throwOnError: true` does **not**
mean "throw if the initial load fails" — it means "throw whenever the last fetch
failed". The moment a *success* path invalidates a query, a transient GET blip
after a write that actually **succeeded** replaces a working, rendered screen
with the error boundary. That shipped: `invalidateMatchViews` added
`invalidateQueries(matchQueryKey(...))` to the save path (#843), so every
successful score save refetched the match — and a blip threw the user out
mid-scoring.

Where the screen has data worth keeping, predicate it instead:

```ts
throwOnError: (_error, query) => query.state.data === undefined
```

An initial load (no cached data) still throws, so the boundary renders its
retry; a background failure leaves last-good data on screen and the next good
refetch heals it. Live in `matchQueryOptions` (`src/api/matches.ts`) and
`tournamentDetailQuery` (`src/components/tournaments/data/api.ts`, which also
excludes an expected 404).

**The test trap:** a background error changes neither `data` nor `isLoading`, so
a tracked-props observer that reads only those never notifies — the component
doesn't re-render, and the throw lands on the *next* render (in production,
whatever else re-renders the screen, e.g. the save mutation settling). A test
must force that render — `rerender(...)` after the failed refetch — or it passes
just as happily against a bare `throwOnError: true`. See the #843 regression
pair in `src/api/matches.test.ts` ("keeps last-good data…" / "throws to the
boundary when the initial match load fails").

Related: `invalidateQueries` defaults to `cancelRefetch: true`, but query-core's
`Query.fetch` only cancels when `state.data !== undefined`. On a cold cache the
second fetch **joins** the in-flight one, so a stale initial fetch can be the
one that wins.

### StrictMode latches a cleanup-only mounted ref

The app root is wrapped in `<StrictMode>` (`src/main.tsx`), so effects fire
mount → cleanup → remount. An is-mounted ref written cleanup-only
(`useRef(true)` + `useEffect(() => () => { ref.current = false }, [])`) latches
`false` on that first simulated unmount and **never recovers**, permanently
disabling whatever it guards — e.g. the post-`await` `navigate()` in
`useStartMatch` (`src/components/matches/match-setup/use-start-match.ts`), which
silently stopped redirecting after a match was created.

Both routine verifications passed while it was broken: `vite build` is a
production build (no double-invoke), and the vitest harness used a plain
`render` (no StrictMode). Only the e2e suite went red — on 10 new-match-flow
specs. Hence:

- **Any is-mounted ref sets `true` in the effect body**, not just `false` in
  cleanup. Same rule for anything else a StrictMode remount has to re-arm.
- **When a vitest harness exercises effect-lifecycle behaviour, wrap the render
  in `<StrictMode>`** so the double-invoke is reproduced — see
  `use-start-match.test.tsx`.
- **Run `npm run test:e2e` even when you've reasoned "no schema change, no stubs
  affected".** Note it only catches this **locally**: `playwright.config.ts`
  serves `vite dev` locally but `vite preview` (production build, no
  double-invoke) on CI.

### The vitest timeout collision produces an opaque red

`src/test/setup.ts` sets Testing Library's `asyncUtilTimeout: 5000`. Left at
vitest's *default* `testTimeout` — also 5000 — a bare `await waitFor(...)` gets a
wait budget equal to the whole test budget: when the async chain is slow both
expire at the same instant and the test dies with `Test timed out in 5000ms`
instead of Testing Library's diagnosable "Unable to find <element>" —
intermittent red CI with zero actionable output.

**`vite.config.ts` therefore sets `testTimeout: 10000`, and these two numbers
must stay unequal.** Don't "tidy" them back to matching: the outer bound exists
so the inner one can expire first and report *what* it was waiting for. This is
the fix for all ~410 `waitFor` call sites at once — only 4 pass a bound of their
own, so per-call discipline was never going to cover it.

- A `waitFor` following a `fireEvent` may still want its own tighter bound, e.g.
  `{ timeout: 2000 }`. (`fireEvent` returns synchronously without flushing
  `act`, unlike `user.click`, so the whole async chain runs inside that window.)
  Examples in `src/components/matches/score-entry.test.tsx`.
- Reproduce flakes with `--no-file-parallelism`, repeatedly; warm runs hide it.
- **Corollary: a 5000ms timeout is not a discriminating "red".** It can't tell
  "the guard blocked the navigation" from "the harness never landed the
  refetch", so a red built on one proves nothing. Discriminate by holding the
  harness, handlers and fixtures byte-identical and varying only the thing under
  test, or by probing the DOM at failure time.

## Conventions

- Path alias: `@/*` → `src/*` (see `vite.config.ts`, `components.json`).
- shadcn components go under `src/components/ui` (configured in
  `components.json`).
- **Render usernames bare — no leading `@`.** Display a username as
  `{username}`, never `@{username}`. This holds everywhere: the dashboard
  greeting, the login confirmation/success screens, the merge gate, the user
  menu, match details, and the topbar pill. (#289)

## Design system

Prefer the shared design-system components in `src/components/ui` (showcased on
the `/design-system` route) whenever one fits the need, instead of hand-rolling a
bespoke inline-styled element. Before building a panel, banner, button, badge,
etc., check `/design-system` for an existing component and use it — match the
semantics, not just the look (e.g. a content panel is a `Card`; a dismissible
"the app talking back" status/notice is an `Alert`, not a `Card`). Apply accent
treatments via the same className/token patterns the showcase uses (e.g. the
`--ball-500`/`--warn`/`--serve-500` tints, `var(--shadow-glow)` for the
"Featured" highlight) rather than reinventing borders and gradients. Reach for a
custom element only when nothing in the design system is a reasonable fit.

## Boundaries

We **parse untrusted data at every boundary with Zod.** The tool per surface:

- **Forms** → React Hook Form + `zodResolver`. See `## Forms` below.
- **URL search + path params** → a Zod schema. Prefer a route
  `validateSearch: (s) => schema.parse(s)` over the raw
  `(search: Record<string, unknown>) => ({ ... })` spread for new routes, so a malformed
  URL fails at the route boundary instead of leaking `undefined`s into the page.
- **Network responses** → Zod-parse the decoded payload at the fetch boundary before it
  flows into the app. The generated `schema.d.ts` (see the root `CLAUDE.md` OpenAPI
  invariant) gives the compile-time shape; Zod gives the runtime guarantee — they're
  complementary, not redundant.
- **`localStorage` / `sessionStorage` / any other external input** → read the value as
  `unknown` and `.parse()` it through a Zod schema; treat a parse failure as absent.

## Forms

**Every form that submits a mutation uses React Hook Form + Zod.** Drive the
form with `useForm({ resolver: zodResolver(schema) })` and validate
client-side against a Zod schema that **mirrors the server's constraints**
(e.g. `z.string().trim().min(1).max(255)` for a column that is `VARCHAR(255)`
and `NOT NULL`) — so the user gets an inline message instead of a bare 4xx.
`EditRoleModal` (`src/components/rbac/roles-page.tsx`) and
`NewTournamentModal` are the reference implementations.

- **Surface server 4xx inline, don't swallow it.** Submit with
  `handleSubmit(async (v) => { try { await mutateAsync(...) } catch (e) { ... } })`,
  and in the catch map an `ApiError` with status 422/409 to
  `form.setError('<field>', { type: 'server', message: e.detail ?? '…' })`;
  toast anything else. A modal must close itself **only on success** — never
  unconditionally after firing the mutation, or a rejected request becomes a
  silent failure (#614).
- **Don't attach a global `onError` toast to a mutation a form surfaces
  inline.** The form owns its errors; a global toast would double up. (See the
  convention note on the RBAC form mutations in `rbac/queries.ts`.)
- **Don't gate the submit button on `formState.isValid`.** `handleSubmit`
  already blocks an invalid submit and renders the inline error; a
  `disabled={!isValid}` button forces a `useEffect(trigger)` workaround for
  edit forms (defaults that start valid) and leaves the user staring at a dead
  button with no explanation. Disable on `isSubmitting` only.

Show field validation errors inline, directly below the field, in red. Set
`aria-invalid` on the `<Input>` and render the message as a `<p>` beneath it:

```tsx
<Input aria-invalid defaultValue="not-an-email" />
<p className="mt-1.5 text-xs text-[color:var(--loss)]">
  Enter a valid email address.
</p>
```

Do not use toasts, alerts, or other patterns for field-level validation errors.

## Read-only surfaces

When a surface is editable by some users and merely viewable by others (today:
the tournament surfaces, gated by the server-computed `canEdit` flag on the
tournament payload), **render a view — do not disable the form.** The reasoning
is in [ADR 0015](../docs/adr/0015-read-only-is-a-view-not-a-disabled-form.md);
the tooling is:

- **`Field` owns the branch.** Give a `Field` row its control *and* the value it
  holds, plus one `readOnly` — it renders one or the other, and drops the form's
  furniture (the **hint** and the **required asterisk**) with it. One flag, one
  obligation; a call site cannot leak a live control, an asterisk, or a hint to a
  reader by forgetting a conditional of its own:

  ```tsx
  <Field label="Entry fee" required readOnly={!canEdit} value={event.entryFee}>
    {(id) => <Input id={id} type="number" … />}
  </Field>
  ```

  The `value` is what a *reader* needs, not what the control needs: an option's
  label (`labelFor` in `data/options.ts`), a formatted date (`fmtDate` in
  `data/helpers.ts`) — never the enum key or the `YYYY-MM-DD` an
  `<input type="date">` takes.
- **`ReadOnlyValue`** (`src/components/tournaments/read-only-value.tsx`) is what
  `Field` renders in that branch, and stays usable directly for the controls that
  aren't a "label + one control + one value" row (a `Switch`, a `ToggleGroup`, the
  pool table chips): the value as text, with the same row rhythm, and an em-dash
  (`EM_DASH`, `data/helpers.ts`) when it is unset. A read-only surface must put
  **no** `<input>` / `<select>` / `<textarea>` / `<switch>` in the accessibility
  tree.
- **Hide mutating affordances — never disable them.** Save, Delete, Revert, and
  the add/remove row buttons are wrapped in `{canEdit && …}`, not given a
  `disabled` prop. A disabled button is an unexplained dead end.
- **Swap organizer-voiced copy.** Imperatives written for the person in control
  ("Edit event", "Click any event to edit") get neutral copy when `!canEdit`.
- **Every read-only-capable component carries a guard test** asserting that with
  `canEdit: false` it renders zero interactive controls. There is **one** sweep,
  in `src/test/read-only.ts` — never a selector re-typed in a page object. Compose
  it:

  ```tsx
  // in the page object
  getFormElements() {
    return interactiveElementsIn(container.getByTestId('basics-section'))
  },

  // in the test
  it('renders no interactive controls for a non-owner', () => {
    basicsSectionPage.render({ event: buildEvent(), canEdit: false })
    expect(basicsSectionPage.getFormElements()).toHaveLength(0)
  })
  ```

  (Scoped to the component's root — make sure that root actually wraps every
  field.) `interactiveElementsIn` sweeps the **DOM**, not ARIA roles, because a
  role-only sweep silently under-proves:

  | Control | Role you'd guess | Role it actually has |
  | --- | --- | --- |
  | `<Input type="number">` | `textbox` | **`spinbutton`** |
  | `<Input type="date">` / `type="time"` | `textbox` | **none at all** |
  | `ToggleGroupItem` | `button` | **`radio`** |

  The toggle case is the nastiest, because an **explicit `role` overrides the
  implicit one**: `ToggleGroupItem` renders `<button role="radio">`, so
  `queryAllByRole('button')` never matches it. A whole live toggle group sails
  through a role sweep — measured, not theorised: with the status ToggleGroup left
  live in the read-only branch, a four-role sweep found **0** controls and passed,
  while the DOM sweep found **5**. `interactiveControlsIn` (the role sweep) may be
  kept *alongside* it, but never instead of it.

  The sweep lives in one module because it forked three ways the first time it was
  copy-pasted — leaving an `<a href>`-shaped hole in six of the eight guards. Add
  a control kind to `INTERACTIVE_SELECTOR` there and every guard tightens at once.

Hiding a control is a UX decision, **never** a security boundary: the API
independently 403s every owner-only endpoint, and must continue to.
