# web-client

The repository's `CLAUDE.md` covers the tasks and layout; `README.md` here has the details. This file holds the conventions for code in the web client.

## Route files are cheap wiring; screens are components

"I'd prefer the route files to just be cheap wiring to a component in components/ for the web client and handling only routing specific concerns, this makes the components easier to test." (the user, 2026-11-14)

Each screen is one component under `src/components/` (where: "Component files follow the component tree", below), named for the screen (`HealthScreen.tsx`, its CSS beside it if it has any). It takes everything it shows as props and holds the screen's markup, state and display logic. A route file in `src/routes/` holds only what the router needs to reach it.

A route file may contain only:

- `createFileRoute('<path>')({...})` with the path.
- `component:` pointing at one component from `src/components/`, rendered with no markup of its own around it; likewise `pendingComponent`, `errorComponent` and `notFoundComponent`, each a component from `src/components/`.
- Validating and typing route inputs: `validateSearch` (zod), `params` parse and stringify, search defaults.
- Loading: `loader`, `beforeLoad`, `loaderDeps`, caching options, and calls from a loader to the typed api functions (`src/api/`) or to a loading function (below). Redirects and `notFound()`/`redirect()` guards (auth, "first launch settled", and so on).
- Reading route data (`Route.useParams()`, `Route.useSearch()`, `Route.useLoaderData()`) in a tiny wrapper whose only job is to hand them to the component as props. Declare it as a function below `Route` (`function HealthRoute()`), not inline: TypeScript can't type `Route` used inside its own initializer.
- `head`/meta (the page title) and the route's `staticData`.
- Router navigation concerns: the type of a link's `to`, preload settings.

Never in a route file: JSX beyond rendering that one component with props; `useState`, `useEffect` or any other state or effect; data fetching inside a component; CSS or styling; formatting or business logic; any markup (headings, wrappers, `<main>`).

Where neither list fits, these are decided:

- **The root route's component is the layout around the router's own `Outlet`**: `component: () => <AppLayout><Outlet /></AppLayout>` in `__root.tsx`, the one place a route renders anything but a single component. `AppLayout` (`src/components/`, README "The layout") holds the top bar (with the sidebar's toggle), the sidebar, whether the sidebar is expanded, and the page's one `<main>`, and takes no route data: the sidebar's current page comes from the router's `<Link>`. A screen renders no `<main>` of its own.
- **What a loader runs that is more than one call** (deciding, waiting, reading again, turning results into what the screen shows) is a loading function in a module of its own, beside what it reads, and the loader only calls it: `checkCore()` in `src/core/check.ts` (`/health`). It returns plain data, never throws for an answer it can give, and knows nothing about screens. Data kept on this device is the exception: the loader awaits a store's `load` (below).
- **A page that shows data kept on this device is a connected component around its screen.** `src/components/<Name>.tsx` (`Settings.tsx` around `SettingsScreen`) reads a store in `src/stores/` with its hook, calls the store's watcher while mounted, and renders the screen with plain props and the store's actions as callbacks. It holds no markup, no state and no logic of its own. The route's loader awaits the store's `load` and returns nothing, and the route's `component` is the connected component. A screen never reads a store. Reads and writes of this device's data go through a store and its actions: no component, route or loader calls `storage.ts`, the core or the device key. The user store is the exception to the watcher: every page shows the user, so it reads every account change and has no watcher (README "The stores"); stores keyed by what a page opens, like the plan's match stores, keep theirs.
- **Answers that arrive separately** are handed to the screen as promises: the loader returns them unawaited and the screen waits for each with the router's `<Await>` and a `fallback` (`HealthScreen`). A screen may use the router's components (`<Link>`, `<Await>`); it never reads route data itself (`Route.useLoaderData()`, `getRouteApi`): the route's wrapper hands it over.

How each part is tested, at the narrowest seam:

- **A screen's behavior**: `<Name>Screen.test.tsx` beside the screen (`src/components/HealthScreen.test.tsx`), with the component rendered alone, given the props each state takes, through its page object beside it, `<Name>Screen.page.tsx`. The page object's `render(props)` calls `renderScreen(<HealthScreen ... />)` (`src/test/render-screen.tsx`), which gives the screen a bare router of its own (`<Link>` and `<Await>` need one) and none of the app's routes. Its other methods only find elements, by role and accessible name, and work wherever the screen is mounted. Every state the screen can show is a case here; nothing is faked, since a screen fetches nothing.
- **A loading function, or an api call**: its own test beside it (`src/core/check.test.ts`, `src/api/health.test.ts`), with only what it reads replaced at a contract (MSW for the api, `vi.mock('./storage.ts')` for storage).
- **A store**: `src/stores/<name>.test.ts`, every case of its logic through its actions, on a fresh store (`create<Name>Store()`), with `storage.ts` replaced and changes announced with the real `announce` (`src/stores/user.test.ts`). The match stores (`match.ts`, `matches.ts`) read and write through a source (`MatchSource`, `match-source.ts`), a memory (`match-memory.ts`) until the plan's tasks D to G2: their tests give fresh stores a fresh memory (`createMatchStore(createMatchMemory())`), and nothing replaces storage. To make the source wait or refuse, a test tells that memory what its next read or write does (`holdNextWrite()`, `holdNextRead()`, `failNextWrite(reason)`, `failNextRead(reason)`, `announceAll()`), or that every read is refused until the function `failReads(reason)` gives is called (storage that stays unavailable: a page whose loaders read the match twice); never a mock of the source. A connected component's test makes the app's own memory (`matchMemory`) refuse the same way, and undoes `failReads` with `onTestFinished`. **A connected component**: `src/components/<Name>.test.tsx`, once, against the real store, with `storage.ts` replaced: that it shows what the store reads after a change (`Settings.test.tsx`).
- **A route**: `src/routes/<route>.test.tsx`, through `renderRoute(path)` (the app's real router and route tree), proves only the wiring, with the screen's page object's finders: the path shows its screen with the loader's data (one case), its pending, error or not-found component, and how params, search and redirects behave. Never a screen's states again.
- **One claim over a table of inputs** (validation especially: "validations are great for test.each in general", the user) is `test.each` with a readable title (`$name`, `%s`), never a `for` loop around `test()` (`NewMatchScreen.schema.test.ts`).

## Component files follow the component tree

"I want it to be that, for CSS and really anything else, the directory structure for the components at least follows the component structure. If I have a new match component and it has a length selector, we should have something like components/NewMatch.tsx and then components/new-match/NewMatchScreen.tsx and then components/new-match/new-match-screen/RatedField.tsx with the css, tests, page object etc for each of those next to the component" (the user, 2026-11-14)

- A component a route renders (`component`, `pendingComponent`...), or a top-level wrapper around a screen (`NewMatch.tsx`, `Settings.tsx`), is directly in `src/components/`.
- A component used by one other component is in a folder beside its parent, named for the parent in kebab-case: `NewMatch.tsx` renders `new-match/NewMatchScreen.tsx`, which renders `new-match/new-match-screen/BestOfField.tsx`. A folder holds the children of exactly one component, and deeper nesting follows the same rule.
- A component used by several (the design system's `Button`, `Icon`, `TextInput`...) is in the folder of the nearest component that contains all its users (`FilterChip`, used by `ControlsTab` and `FilterChips`, is in `controls-tab/`); when its users have no common ancestor, it is directly in `src/components/`. Importing a component's CSS (`TabNav` wears `Tabs.css`) counts as using it.
- Everything of a component's own sits beside it, with its name: its CSS, its tests (`BestOfField.test.tsx`, `Button.test-d.tsx`), its page object (`NewMatchScreen.page.tsx`). A helper module or stylesheet shared by several components (`single-selection.ts`, `choice.css`, `forced-state.ts`) follows the same rule as a shared component, by who imports it.
- A file goes where its main component goes (the one it is named for); a route may import a sibling export from it: `/settings`'s `pendingComponent` is `SettingsScreenPending`, from `settings/SettingsScreen.tsx`.
- Placement follows the imports: when a component gains or loses a user, move it (`git mv`) to where the rule now puts it. A test that covers several components (`DesignSystemTabs.test.tsx`, the five tabs) sits with the nearest folder that holds them all.

## Screenshot tests are for the design system pages only

"let's ditch screenshot tests anywhere except the design system pages, they are fragile, I don't want to fix this test or mock the api." (the user, 2026-11-14)

- A screenshot test (`toHaveScreenshot`) is only ever of a design system page, `/design-system/*` (`e2e/tests/design-system*.spec.ts`). No other screen and no part of the layout gets one, and no test mocks the api to make a picture hold still.
- How everything else looks is pinned by no test, and never by reading a style. What a browser alone can show about it (which parts a media query shows) is a browser test by role and visibility, on a page that needs no network (`e2e/tests/app-layout.spec.ts`, on `/`).

## The design system's components

The controls under `src/components/` (`Button`, `Field`, `Checkbox`, `Tabs`...; README "The controls") are the design system's, checked against its reference sheet, `../references/design-system/`.

- A component is the real element (`<button>`, `<input>` inside its `<label>`, `role="tab"`, `role="switch"`), named the way the design system says, one per file with its CSS beside it. Every colour is a token (mix a token with `color-mix()` rather than copy a value); only sizes the tokens lack are px.
- Its CSS follows the kit's `fm-*` rule for it in `reference.css`. A change to how one looks changes its screenshots: write them again (`./bin/mise run web-client:e2e -- --update-snapshots`) and look at each beside the same `data-testid` on the board before committing.
- A state the design system page draws without causing it (hover, focus, pressed) is the `forcedState` prop, rendered as `data-forced-state`, beside the real pseudo-class in the same CSS rule. Nothing else sets it.
- What a component does is its own test, `<Name>.test.tsx` beside it, rendered alone, by role and accessible name; how it looks is only ever a screenshot (`e2e/tests/design-system-<tab>.spec.ts`), never a style read in a test.
- The design system page (`/design-system`, README "The design system page") has a tab per board of the reference sheet, each a subroute whose route file names one `<Name>Tab` component; `/design-system` redirects to the first. A new target on a board gets the board's `data-testid` in its tab (`ColourTab`, `TypeTab`, `FoundationsTab`, `ControlsTab`, `FeedbackTab`), laid out with `Board.tsx`, and a line in that tab's spec.
- The page shows a token's value by reading it from the stylesheet (`tokenValue()`, `colourValue()` in `src/theme/token-value.ts`), never by writing it down: the page names tokens, the theme gives values.
- Navigation that looks like tabs is `TabNav` (router links, `aria-current="page"`), not `Tabs` (a tablist on one page); both wear `Tabs.css`.

## Answers from the api are parsed with zod, at the boundary

Every conversion at the api boundary is done with zod, in the schema: telling a call's answers apart, camelCase keys, date values and conveniences like them. Never do them by hand in components or helpers.

- A call in `src/api/<resource>.ts` sends its request through `api` (`src/api/client.ts`), takes the body with `bodyOf(...)` as `unknown`, and parses it once with zod. Never read openapi-fetch's `data` or `error` directly.
- A call's possible answers are one zod sum type: `z.discriminatedUnion` when the bodies share a discriminator key, otherwise `z.union`. Code branches on the parsed variant, never on `response.status` and never with hand-written type predicates. A body that matches no variant is an answer of its own (for health, `unknown`), not an exception.
- Each variant's input is the wire shape, bound to the api's OpenAPI document with `fromWire('<SchemaName>')(...)` (`src/api/wire.ts`), so a field renamed, removed or added in `api/openapi.json` fails `web-client:typecheck` once `web-client:api-types` regenerates `schema.gen.ts`.
- Its output is the app's own type, made by `.transform(...)` in the schema (`fetchHealth` returns `Health`). App code and components use the output types, never the wire types in `schema.gen.ts`.
- The boundary is where the wire format stops: past it there are no snake_case keys and no date strings ("I don't want snake case or string dates from the api"). The schema's transform converts snake_case keys to camelCase and date strings to date values. No answer has either yet, so don't build a generic converter before the first field that needs one.

`src/api/health.ts` is the example to copy.

## Forms

"let's use zod and react hook form, converting the new match form to this along the way" (the user, 2026-11-14)

A form is a React Hook Form form whose rules are one zod schema. The new match form (`src/components/new-match/NewMatchScreen.tsx`, with `NewMatchScreen.schema.ts`) is the smallest example to copy; the scoring form (`src/components/scoring/ScoringScreen.tsx`, with `ScoringScreen.schema.ts`) has text fields and errors.

- **The schema is the one place a form's rules are written**: what is required, trimming, the choices a field allows, and the error messages, word for word. It sits beside the screen whose form it is, named for it (`<Name>Screen.schema.ts`), until a second form uses it; then it moves by the component tree's rule. Its input type (`z.input`) is what the form holds, and its output (`z.output`, made by `.transform(...)`) is what the screen hands its `onSubmit`. Never write a rule again in a component: where a screen needs to know whether a value passes (the scoring screen's typed score, to say what saving it does), it asks the schema (`schema.safeParse(...)`).
- **React Hook Form holds the state**: `useForm<Input, unknown, Output>({ resolver: zodResolver(schema), defaultValues })`, with the defaults beside the schema. No `useState` for a field's value, its error or whether it changed. A text input is `register`ed (its `ref` reaches the `<input>`: `TextInput` takes one); a design-system control that isn't a native input (`BestOfField`, `Switch`) goes through `Controller`. Read values for display with `useWatch`, not `watch` (the React Compiler skips a component that calls `watch`). A field that follows another is set with `setValue` in the other's `onChange`.
- **Errors show after the first submit**, then follow what is typed: React Hook Form's default modes (`mode: 'onSubmit'`, `reValidateMode: 'onChange'`), and the default focus on the first invalid field. The error goes to the `Field` as `error={errors.<field>?.message}`; the form has `noValidate`. Submit with `handleSubmit((output) => onSubmit(output))`, so the handler gets the parsed output and nothing else.
- **Dirty is the form's own**: `formState.isDirty`, against `defaultValues`, so a form changed back to how it opened is not dirty. A screen that asks before leaving has one guard, `useBlocker({ shouldBlockFn: () => isDirty, enableBeforeUnload: () => isDirty, withResolver: true })`, and nothing else decides it. A submitted form is still dirty: whatever navigates after a submit must get past that one guard (leave it to the task that navigates).
- **Tests.** The schema's rules are its own test, `<Name>Screen.schema.test.ts`, called directly: every variant once, the refused inputs as a `test.each` table (`NewMatchScreen.schema.test.ts`). The screen's test proves through the page object, by role, that it uses them: one case per outcome (the error shown and focused, the handler's match, the leave guard asking or not).

## This device's signing key

`src/device-key.ts` (README "This device's signing key") is the only place the web client makes, keeps or signs with a key.

- The private key is made non-extractable and kept as the `CryptoKey` object in IndexedDB. Never export it, never make it extractable, never keep it as bytes, and never pass it to the core: the core gets the 33-byte public key and the signatures.
- The key is reached only through `withDeviceKey(callback)`, which runs the callback inside the append lock (`appendLock`, in `src/storage.ts`) with the key, made there if none is kept. The journal's appends take the same lock.
- Callbacks are short: every append, in every tab, waits for them. Inside one, write and read with the `store` it gets, never the public `storeRecord`, which would wait for the lock the callback holds, for ever (Web Locks are not re-entrant). Never keep `store` past the callback.
- A browser that can't make or keep the key is a typed result (`{ ok: false, reason }`), never a thrown error, and never a key that isn't kept. A callback that throws makes `withDeviceKey` throw, with the lock released.
- Feature code never signs (design 4.3); what makes records does: the first launch (its hello), and `commit` in `src/journal.ts` (every other record: a draft decides on what the held store reads, `make` signs and assembles, and nothing is kept unless every record is; README "Making records").
- Claims about the real key go in the browser suite (`e2e/tests/device-key.spec.ts`, through `e2e/harness/`); jsdom has no IndexedDB and no real `CryptoKey` to keep.
- To learn which account this device has (a screen loading), read the user store (`src/stores/user.ts`, whose `load` calls `loadMe()` in `src/storage.ts`), never `withDeviceKey`: one read, no key, no core. Opening a page never mints an identity; only the first launch at app startup does.

## The first launch

`src/first-launch.ts` (README "The first launch") makes this device's key, hello and user, once, at app startup (`main.tsx`), in the background, without delaying the first paint.

- The first paint never waits for it, and it never throws. A failure leaves no user, and the next start tries again. `main.tsx` starts it through the user store (`userStore.getState().launch()`, which reads the user first, so a device that has one shows it without waiting for the launch, then calls `launchAtStartup()`, then reads the user again). With no account yet, the user store's `load` waits for it with `startupLaunchSettled()`, which is bounded (`startupLaunchBound`, 5 seconds) and never starts a launch. Nothing else awaits it.
- Everything it reads and writes goes through one `withDeviceKey` callback, with `store`: "is there a user for this key?", then the hello, stored with `{ me: true }`. Two tabs at once end with one key, one hello and one user.
- Its environment number is `environment` there, a placeholder (development, 3) until real environments exist. Records made elsewhere use the same constant.
- Its claims are in the browser suite (`e2e/tests/first-launch.spec.ts`, and `/settings` after it in `e2e/tests/settings.spec.ts`), through the shipped app.

## Records and users on this device

`src/storage.ts` (README "Records and users on this device") is the only code that opens the `fortymm-storage` database. Its interface is `storeRecord(record)`, `loadUser(playerId)`, `loadMe()`, `loadMatch(matchId)`, `loadMatches()` and `rebuildViews()`; widen it only when a claim needs it. After every write transaction completes it announces what changed (`announce`, `src/changes.ts`: `account: true` for a hello, which stores a user; the ids of the matches an append touched; `'all'` for a rebuild); nothing else announces. `heldStore` is `storeRecord` (which takes `{ me: true }` there), `loadUser`, `append(records)` and `loadMatch` (with each game's current entries) without a lock of their own, for `withDeviceKey` to hand its callback, and for nothing else: only the code holding the device key says which user is this device's, and only it makes records.

- The record's bytes are the source of truth; a row (a user, a match's view row) is a copy of what the core reads from them, rebuildable from the records. Never parse record bytes in the app.
- **A view holds only what the core computed from records** (the user, 2026-11-15: "we should keep the app from reading the records, only read the derived tables"). The `matches` view is written by one function, `writeView`, from `core.matchState` of the match's kept records, and `rebuildViews` writes it again from the journal alone with the same rows. Nothing typed goes in a view, and storage keeps no typed opponent's name at all (the user, 2026-11-16: "I don't actually care about the typed names at all"): `loadMatch` and `loadMatches` give a match as its records say (the stores' `StoredMatch` and `MatchSummary`, which carry no name), and the app shows the opponent as "Anonymous". A name, if it comes back, goes in a table of its own, never in a view. The rules live in the derivation (the core), not in the app and not in refusing records: storage keeps any `player`, `match` or `score` record that verifies.
- A record, its journal row and every row computed from it (its user, the view rows of the matches it touches) are written in one transaction, with strict durability, inside the append lock (`appendLock`). Never write one without the others, and never write a view row outside the transaction that keeps the records it comes from.
- The "me" pointer (store `me`) says which stored user is this device's. It is written in the same transaction as that user (`storeRecord(record, { me: true })`), so it never points at a user that isn't stored. `loadMe` reads it and the user in one transaction, with no lock.
- Failures are typed results (`{ ok: false, reason }`), never thrown, as in `device-key.ts`. A missing row is `null`, not a failure.
- Never hold a connection to the database while waiting for the append lock: open it once the lock is held (`withDatabase`), and only through `openStorage`, whose connections close on `versionchange`. A connection open while waiting deadlocks every tab against a pending delete or upgrade (README, "A delete or upgrade of the database never hangs storage").
- Claims about what is kept go in the browser suite (`e2e/tests/storage.spec.ts` for hellos and users, `e2e/tests/storage-matches.spec.ts` and `storage-matches-random.spec.ts` for the journal and the views, through `e2e/harness/storage.html`). A test of a view compares it with what the core gives for the kept records, worked out by the harness from the `records` store alone (`expectedViews`), never with a copy of the derivation. A test of code that reads storage replaces only the storage it reads (`vi.mock('./storage.ts')`, `loadMe` for this device's user), as the user store's test `src/stores/user.test.ts` and the route test `src/routes/settings.test.tsx` do; a screen reads none, so its test replaces nothing.

## The app is kept on the device

The service worker (`offline/`, README "Opening with no connection") keeps every file of the build and answers page loads with the kept `index.html`. Keep it that way:

- Never answer a request under `/api/` from the service worker, and never keep an api answer in it. Data on the device belongs in its own store, with the tasks that add it.
- Don't list files to keep by hand: the build keeps whatever it emitted.
- Never take over or reload a page that is open without its user's say: the worker calls `skipWaiting()` only on a page's take-over message, and a page reloads on `controllerchange` only after its own Reload asked (`src/new-version.ts`). Otherwise a new version shows at the next opening, and meanwhile the layout says it is ready (`UpdateNotice`), only once every file of it is kept.
