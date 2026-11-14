# web-client

The repository's `CLAUDE.md` covers the tasks and layout; `README.md` here has the details. This file holds the conventions for code in the web client.

## Route files are cheap wiring; screens are components

"I'd prefer the route files to just be cheap wiring to a component in components/ for the web client and handling only routing specific concerns, this makes the components easier to test." (the user, 2026-11-14)

Each screen is one component in `src/components/`, named for the screen (`HealthScreen.tsx`, its CSS beside it if it has any). It takes everything it shows as props and holds the screen's markup, state and display logic. A route file in `src/routes/` holds only what the router needs to reach it.

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

- **The root route's component is the layout around the router's own `Outlet`**: `component: () => <AppLayout><Outlet /></AppLayout>` in `__root.tsx`, the one place a route renders anything but a single component. `AppLayout` (`src/components/`, README "The layout") holds the top bar, the sidebar and the page's one `<main>`, and takes no route data: the sidebar's current page comes from the router's `<Link>`. A screen renders no `<main>` of its own.
- **What a loader runs that is more than one call** (deciding, waiting, reading again, turning results into what the screen shows) is a loading function in a module of its own, beside what it reads, and the loader only calls it: `ownAccount()` in `src/account.ts` (`/settings`), `checkCore()` in `src/core/check.ts` (`/health`). It returns plain data, never throws for an answer it can give, and knows nothing about screens.
- **Answers that arrive separately** are handed to the screen as promises: the loader returns them unawaited and the screen waits for each with the router's `<Await>` and a `fallback` (`HealthScreen`). A screen may use the router's components (`<Link>`, `<Await>`); it never reads route data itself (`Route.useLoaderData()`, `getRouteApi`): the route's wrapper hands it over.

How each part is tested, at the narrowest seam:

- **A screen's behavior**: `src/components/<Name>Screen.test.tsx`, with the component rendered alone, given the props each state takes, through its page object `src/components/<Name>Screen.page.tsx`. The page object's `render(props)` calls `renderScreen(<HealthScreen ... />)` (`src/test/render-screen.tsx`), which gives the screen a bare router of its own (`<Link>` and `<Await>` need one) and none of the app's routes. Its other methods only find elements, by role and accessible name, and work wherever the screen is mounted. Every state the screen can show is a case here; nothing is faked, since a screen fetches nothing.
- **A loading function, or an api call**: its own test beside it (`src/account.test.ts`, `src/core/check.test.ts`, `src/api/health.test.ts`), with only what it reads replaced at a contract (MSW for the api, `vi.mock('./storage.ts')` for storage).
- **A route**: `src/routes/<route>.test.tsx`, through `renderRoute(path)` (the app's real router and route tree), proves only the wiring, with the screen's page object's finders: the path shows its screen with the loader's data (one case), its pending, error or not-found component, and how params, search and redirects behave. Never a screen's states again.

## The design system's components

The controls in `src/components/` (`Button`, `Field`, `Checkbox`, `Tabs`...; README "The controls") are the design system's, checked against its reference sheet, `../references/design-system/`.

- A component is the real element (`<button>`, `<input>` inside its `<label>`, `role="tab"`, `role="switch"`), named the way the design system says, one per file with its CSS beside it. Every colour is a token (mix a token with `color-mix()` rather than copy a value); only sizes the tokens lack are px.
- Its CSS follows the kit's `fm-*` rule for it in `reference.css`. A change to how one looks changes its screenshots: write them again (`./bin/mise run web-client:e2e -- --update-snapshots`) and look at each beside the same `data-testid` on the board before committing.
- A state the design system page draws without causing it (hover, focus, pressed) is the `forcedState` prop, rendered as `data-forced-state`, beside the real pseudo-class in the same CSS rule. Nothing else sets it.
- What a component does is its own test, `src/components/<Name>.test.tsx`, rendered alone, by role and accessible name; how it looks is only ever a screenshot (`e2e/tests/design-system.spec.ts`; the layout's, `e2e/tests/app-layout.spec.ts`), never a style read in a test.
- A new target on the board gets the board's `data-testid` in `ControlsSection` and a line in `design-system.spec.ts`.

## Answers from the api are parsed with zod, at the boundary

Every conversion at the api boundary is done with zod, in the schema: telling a call's answers apart, camelCase keys, date values and conveniences like them. Never do them by hand in components or helpers.

- A call in `src/api/<resource>.ts` sends its request through `api` (`src/api/client.ts`), takes the body with `bodyOf(...)` as `unknown`, and parses it once with zod. Never read openapi-fetch's `data` or `error` directly.
- A call's possible answers are one zod sum type: `z.discriminatedUnion` when the bodies share a discriminator key, otherwise `z.union`. Code branches on the parsed variant, never on `response.status` and never with hand-written type predicates. A body that matches no variant is an answer of its own (for health, `unknown`), not an exception.
- Each variant's input is the wire shape, bound to the api's OpenAPI document with `fromWire('<SchemaName>')(...)` (`src/api/wire.ts`), so a field renamed, removed or added in `api/openapi.json` fails `web-client:typecheck` once `web-client:api-types` regenerates `schema.gen.ts`.
- Its output is the app's own type, made by `.transform(...)` in the schema (`fetchHealth` returns `Health`). App code and components use the output types, never the wire types in `schema.gen.ts`.
- The boundary is where the wire format stops: past it there are no snake_case keys and no date strings ("I don't want snake case or string dates from the api"). The schema's transform converts snake_case keys to camelCase and date strings to date values. No answer has either yet, so don't build a generic converter before the first field that needs one.

`src/api/health.ts` is the example to copy.

## This device's signing key

`src/device-key.ts` (README "This device's signing key") is the only place the web client makes, keeps or signs with a key.

- The private key is made non-extractable and kept as the `CryptoKey` object in IndexedDB. Never export it, never make it extractable, never keep it as bytes, and never pass it to the core: the core gets the 33-byte public key and the signatures.
- The key is reached only through `withDeviceKey(callback)`, which runs the callback inside the append lock (`appendLock`, in `src/storage.ts`) with the key, made there if none is kept. The journal's appends take the same lock.
- Callbacks are short: every append, in every tab, waits for them. Inside one, write and read with the `store` it gets, never the public `storeRecord`, which would wait for the lock the callback holds, for ever (Web Locks are not re-entrant). Never keep `store` past the callback.
- A browser that can't make or keep the key is a typed result (`{ ok: false, reason }`), never a thrown error, and never a key that isn't kept. A callback that throws makes `withDeviceKey` throw, with the lock released.
- Feature code never signs (design 4.3); what makes records does (today, the first launch).
- Claims about the real key go in the browser suite (`e2e/tests/device-key.spec.ts`, through `e2e/harness/`); jsdom has no IndexedDB and no real `CryptoKey` to keep.
- To learn which account this device has (a screen loading), use `loadMe()` (`src/storage.ts`), never `withDeviceKey`: one read, no key, no core. Opening a page never mints an identity; only the first launch at app startup does.

## The first launch

`src/first-launch.ts` (README "The first launch") makes this device's key, hello and user, once, at app startup (`main.tsx`), in the background, without delaying the first paint.

- The first paint never waits for it, and it never throws. A failure leaves no user, and the next start tries again. A screen that finds no account yet may wait for it with `startupLaunchSettled()`, which is bounded (`startupLaunchBound`, 5 seconds) and never starts a launch; `/settings` does. Nothing else awaits it.
- Everything it reads and writes goes through one `withDeviceKey` callback, with `store`: "is there a user for this key?", then the hello, stored with `{ me: true }`. Two tabs at once end with one key, one hello and one user.
- Its environment number is `environment` there, a placeholder (development, 3) until real environments exist. Records made elsewhere use the same constant.
- Its claims are in the browser suite (`e2e/tests/first-launch.spec.ts`, and `/settings` after it in `e2e/tests/settings.spec.ts`), through the shipped app.

## Records and users on this device

`src/storage.ts` (README "Records and users on this device") is the only code that opens the `fortymm-storage` database. Its interface is three functions, `storeRecord(record)`, `loadUser(playerId)` and `loadMe()`; widen it only when a claim needs it. `heldStore` is `storeRecord` (which takes `{ me: true }` there) and `loadUser` without a lock of their own, for `withDeviceKey` to hand its callback, and for nothing else: only the code holding the device key says which user is this device's.

- The record's bytes are the source of truth; a row (the user) is a copy of what the core's getters read from it, rebuildable from the records. Never parse record bytes in the app.
- A record and every row it mints are written in one transaction, with strict durability, inside the append lock (`appendLock`). Never write one without the other.
- The "me" pointer (store `me`) says which stored user is this device's. It is written in the same transaction as that user (`storeRecord(record, { me: true })`), so it never points at a user that isn't stored. `loadMe` reads it and the user in one transaction, with no lock.
- Failures are typed results (`{ ok: false, reason }`), never thrown, as in `device-key.ts`. A missing row is `null`, not a failure.
- Claims about what is kept go in the browser suite (`e2e/tests/storage.spec.ts`, through `e2e/harness/storage.html`). A test of code that reads storage replaces only the storage it reads (`vi.mock('./storage.ts')`, `loadMe` for this device's user), as `src/account.test.ts` and the route test `src/routes/settings.test.tsx` do; a screen reads none, so its test replaces nothing.

## The app is kept on the device

The service worker (`offline/`, README "Opening with no connection") keeps every file of the build and answers page loads with the kept `index.html`. Keep it that way:

- Never answer a request under `/api/` from the service worker, and never keep an api answer in it. Data on the device belongs in its own store, with the tasks that add it.
- Don't list files to keep by hand: the build keeps whatever it emitted.
- Never take over or reload a page that is open: no `skipWaiting()`, no reload on `controllerchange`. A new version shows at the next opening.
