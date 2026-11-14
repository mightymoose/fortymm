# web-client

The fortymm web client: Vite, React, TypeScript and [TanStack Router](https://tanstack.com/router) with file-based routing. Run everything through `./bin/mise run web-client:<task>` from the repository root, never with `npm` on the host; `CLAUDE.md` lists the tasks.

## Routes

Each screen has a route file in `src/routes/` and a component in `src/components/`. The file name is the URL (`index.tsx` is `/`; `about.tsx` would be `/about`). See TanStack Router's [file naming conventions](https://tanstack.com/router/latest/docs/framework/react/routing/file-naming-conventions).

Route files are cheap wiring (the user's rule; the allow list and the decisions are in `CLAUDE.md`, "Route files are cheap wiring; screens are components"). A route file names its path, loads what the screen needs, and hands it to one screen component, `src/components/<Name>Screen.tsx`, as props; the screen holds every bit of markup, state and display logic, so it can be tested alone. What a loader runs beyond one call lives in a loading function of its own (`ownAccount()` in `src/account.ts`, `checkCore()` in `src/core/check.ts`). `/health`'s route file is all of it:

```tsx
export const Route = createFileRoute('/health')({
  loader: () => ({ health: fetchHealth(), core: checkCore() }),
  component: HealthRoute,
})

function HealthRoute() {
  const { health, core } = Route.useLoaderData()
  return <HealthScreen health={health} core={core} />
}
```

- `src/routes/__root.tsx` is the root route: every screen renders in its `<Outlet />`, inside the layout every screen shares (`component: () => <AppLayout><Outlet /></AppLayout>`, "The layout" below); its `notFoundComponent`, `NotFoundScreen`, is shown for any URL that matches no route, inside the layout too.
- `src/routes/index.tsx` is the start page at `/` (`StartScreen`). It is blank, on the theme's background, inside the layout; its one element is a heading for screen readers.
- `src/routes/design-system.tsx` is the design system page at `/design-system` (`DesignSystemScreen`, "The theme" below).
- `src/routes/health.tsx` is the health page at `/health` (`HealthScreen`, "The shared core" below).
- `src/routes/settings.tsx` is the account settings page at `/settings` (`SettingsScreen`, and `SettingsScreenPending` while it reads; "The account settings page" below).
- `src/router.ts` creates the router and registers it with the type checker, so a `<Link>` or `navigate()` to a path with no route file fails `web-client:typecheck`.

### The layout

Every screen renders inside `AppLayout` (`src/components/AppLayout.tsx`), which the root route wraps around its `<Outlet />`:

- **Surfaces.** The top bar and the sidebar are panels, on bg-panel ("for sidebars and grouped content", in the design system's README; its own organizer desktop puts its top bar on bg-panel too), over the page's bg-app. They meet as one L-shaped panel with no line between them; a border-subtle divider runs only where they meet the page (the screen's top edge, the sidebar's right edge). Flat: no shadow.
- **The top bar** (`TopBar`, a `<header>`, the page's banner), 56px high at every width: at non-phone widths, the sidebar's toggle, then the brand, on the left; on phones, the brand alone, centred. The brand is the FortyMM wordmark in Bebas Neue at 24px (`--text-xl`, half the `scoreboard-display` size), a link to `/`, in fg-1, never orange. It is not a heading; each screen has its own `<h1>`. The toggle, a `<button>` named "Sidebar" with `aria-expanded` and `aria-controls` (the sidebar's `<nav>`), collapses the sidebar to icons only and expands it again; its icon sits over the sidebar's icons.
- **The sidebar** (`Sidebar`, a `<nav aria-label="Main">`): at non-phone widths only, the links and nothing else. A link with a Lucide icon (`Icon`) and a label for each of `/health`, `/settings` and `/design-system`; the router's `<Link>` marks the current page's `aria-current="page"`, which is styled as the selected item (accent-soft, accent-text, the layout's only orange). Collapsed, each label is visually hidden, so each link keeps its name (no tooltips: the design system's tooltip isn't built yet).
- **Expanded or collapsed** is the layout's state (`AppLayout`), since the toggle and the sidebar are in different parts: it starts expanded, lasts while the app is open, since the layout stays mounted from page to page, and is kept nowhere: keeping it across openings is a follow-up.
- **The screen** goes in the page's one `<main>`, the layout's, filling the rest, on bg-app, with the app's margins (24px, 16px). Screens don't render a `<main>` of their own.
- **The breakpoint** between phone and non-phone is 768px, written once, in `AppLayout.css`: a media query can't read a custom property, so that one query sets `--app-layout-sidebar-display` and `--app-layout-brand-justify`, which `Sidebar.css` and `TopBar.css` (the toggle's display, the brand's place) read. Below 768px there is no sidebar and no toggle, and **no way to navigate by link yet on a phone**: a phone navigation is still to come.
- **Scrolling.** The whole page scrolls as one document. The top bar, and the toggle in it, scroll away with it; the sidebar runs the page's full height, and its links stick to the top of the viewport, so they stay in view on a long page (`/design-system`).
- **Tests.** What each part does is a component test, rendered alone through the page object `src/components/AppLayout.page.tsx`: the sidebar's links, their destinations and order, names kept when collapsed, `aria-current` on the current page (`Sidebar.test.tsx`, rendered at a path with `renderScreen(..., { path })`); the brand's link to `/` and that it isn't a heading, and the toggle in the top bar, before the brand, with `aria-expanded` and `aria-controls` from its props, asking to toggle when pressed (`TopBar.test.tsx`); the content in the one `<main>`, and the sidebar starting expanded, the toggle collapsing and expanding it and controlling its `<nav>` (`AppLayout.test.tsx`). The root route's wiring (a screen and the not-found screen inside the layout, the sidebar staying collapsed from page to page) is `src/routes/__root.test.tsx`. That the sidebar and the toggle are there on a desktop and not on a phone (the breakpoint, which jsdom doesn't apply) is the browser suite's `e2e/tests/app-layout.spec.ts`, on the blank start page, by role and visibility only. How the layout looks is pinned by no test: screenshot tests are only for the design system pages ("Screenshots" below). That collapsed shows only the icons is among what no test pins: a visually hidden label still counts as visible to Playwright (its box is 1px), so only a picture could show it.

To add a screen, add its component in `src/components/` and a route file that exports `Route = createFileRoute('/path')({ component })` pointing at it. Nothing else needs registering. The Vite plugin regenerates `src/routeTree.gen.ts` when the dev server (`web-client:up`) starts, whenever a route file changes, and on build.

`src/routeTree.gen.ts` is generated but committed, so the type checker and editors work on a fresh checkout. Don't edit it. If it disagrees with `src/routes/`, `web-client:routes-check` (first step of `web-client:validate`, so in CI) fails, regenerates it, and you commit the result. Generator options go in `tsr.config.json`, which both the Vite plugin and the check read. Lint skips the file.

## Calling the api

| What | Where |
| --- | --- |
| The api's types, generated from `../api/openapi.json` | `src/api/schema.gen.ts` (committed, never edited) |
| The one client every call goes through (openapi-fetch) | `src/api/client.ts` |
| `fromWire`, which binds a zod schema's input to the document | `src/api/wire.ts` |
| A call, its zod schemas, and the app type it returns | `src/api/<resource>.ts`, e.g. `fetchHealth()` in `src/api/health.ts` |
| The call's MSW handlers, for component tests | `src/test/api/<resource>.ts` |

- **Types.** `web-client:api-types` regenerates `src/api/schema.gen.ts` with [openapi-typescript](https://openapi-ts.dev/). Run it after `api:openapi` changes the document, and commit both. `web-client:api-types-check` (in `web-client:validate`, so in CI) fails when the file is stale, and regenerates it. The generator runs in its own tool image, `dev/web-client-openapi/`, because it needs TypeScript 5's compiler API and this app is on TypeScript 7.
- **Client.** [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) typed by those types: `api.GET('/v1/health')`. A path, method or parameter the document doesn't have fails `web-client:typecheck`. Paths are the api's own (`/v1/...`). The client types the request only; what came back is decided by zod.
- **Answers.** A call takes the body with `bodyOf(...)` as `unknown` and parses it once against a [zod](https://zod.dev/) union of the answers it understands. Each variant is a hand-written schema: wire type in, app type out.
  - *In:* `fromWire('HealthDocument')(schema)` fails `web-client:typecheck` unless the schema's input type and the document's `HealthDocument` (from `schema.gen.ts`) are each assignable to the other. A field renamed, removed or added in the document, or a value it no longer allows, fails once the types are regenerated.
  - *Out:* `.transform(...)` turns the wire shape into the app's type (`Health`). This is where snake_case keys will become camelCase and date strings date values. App code uses only the output types.
  - A body that matches no variant (another status, an HTML page, a changed api) is an answer of its own (`unknown`), not a thrown error. `web-client/CLAUDE.md` has the rules in short.
- **Where the api is.** At `/api` on the app's own origin. Whatever serves the app forwards `/api/*` to the api with `/api` stripped, so `/api/v1/health` reaches the api's `/v1/health`: Vite's `server.proxy` in dev (`vite.config.ts`, to the `api` service), and the production hosting, the Worker ("Hosting" below), to the api its deployment names (a pull request's preview: that pull request's api; the cross-app suite: `api-release`). A Worker deployed without an api, as production is for now, answers `/api` and `/api/*` with a 404. So no route file may produce a URL starting with `/api`.
- **Screens that load data** use a route `loader` that calls the `src/api/` function, and show something for while it's on the way: a `pendingComponent`, or, when a screen has answers that arrive separately, a loader that returns the promises unawaited and an `<Await>` with a `fallback` for each in the screen component, so one slow answer never holds up another (see `src/routes/health.tsx` and `src/components/HealthScreen.tsx`, where a slow api must not hide the core's answer). Turn every answer, including "couldn't reach the api", into data the component shows; don't let the loader throw for an answer the api can give.

## The shared core

The core (`../core/`, the Rust library) runs in the browser as a WebAssembly module with a small hand-written wrapper. Web client code calls it like this:

```ts
import { loadCore } from '../core/load.ts'

const core = await loadCore()
core.username(playerId, 4) // synchronous once loaded
```

- **Where it comes from.** `core:wasm` builds the module and publishes it with the wrapper (`fortymm-core.mjs`) and its types (`fortymm-core.d.mts`) to `/opt/core/wasm` in the `core-cache` volume. The `web-client` service mounts the volume read-only at `/opt/core`, and the app imports it as `fortymm-core/...`: an alias in `vite.config.ts` (with `server.fs.allow`, so the dev server serves it) and a path in `tsconfig.app.json`, so the types are the core's own. `web-client:up`, `:typecheck`, `:test` and `:build` run `core:wasm` first; nothing else needs setting up.
- **Loading.** `src/core/load.ts` fetches the module and instantiates it once per page, and every caller gets the same `Core`. A load that fails is forgotten, so the next caller tries again. The build emits the module as `dist/assets/fortymm-core-<hash>.wasm` (about 139 kB, 62 kB gzipped), so the service worker keeps it with every other file and the core loads with no connection, and the hosting serves it like any file under `/assets/` (`application/wasm`, cached for a year).
- **Tests.** `src/test/setup.ts` replaces `load.ts` in component tests with one that reads the same real module from disk, since jsdom can't fetch it. A test makes loading fail with `vi.mocked(loadCore).mockRejectedValue(...)`; it goes back to the real core after each test. `src/core/load.test.ts` tests the real `load.ts`, with MSW serving the module, and `src/core/load.test-d.ts` proves the wrapper is typed from `fortymm-core.d.mts`.
- **Where it shows.** `/health` says whether the core loaded, with the username it gives a fixed player id, one of the core's golden vectors (`../core/vectors/vectors.json`, "usernames"). If it can't load, the page says so and still gives the api's answer. The check is `checkCore()` (`src/core/check.ts`, tested against the real core in `src/core/check.test.ts`); the route's loader calls it, and `HealthScreen` shows its answer.

## This device's signing key

Records are signed on the device that makes them (design sections 4.4 and 5.4, the Web row). `src/device-key.ts` holds this device's key:

```ts
import { storedSignature, withDeviceKey } from '../device-key.ts'

const result = await withDeviceKey(async (key, store) => {
  key.publicKey                       // 33 bytes, compressed: what a record stores
  const raw = await key.sign(bytes)   // WebCrypto's 64-byte r||s
  storedSignature(core, raw)          // the core's signatureFromRaw: what a record stores
  return store.storeRecord(record)    // store: storeRecord and loadUser, taking no lock
})
if (!result.ok) return result.reason // 'signing-unavailable' | 'storage-unavailable' | 'locks-unavailable'
result.value                         // what the callback returned
```

- **One lock.** `withDeviceKey` takes the Web Lock `fortymm-journal-append` (`appendLock`, in `src/storage.ts`), the lock every write to storage and the journal's appends take (design 5.4). Inside it, it gets the kept key, or makes and keeps one, then calls the callback with the key and `store`, and releases the lock when the callback settles, even when it throws (`withDeviceKey` then throws the same error).
- **Inside the callback, use `store`.** It is `storeRecord` and `loadUser` taking no lock of their own (`heldStore` in `src/storage.ts`), since the lock is held. The public `storeRecord` would wait for that lock, for ever: Web Locks are not re-entrant. Don't keep `store` past the callback.
- **Keep callbacks short.** Every write to storage, in every tab, waits for them.

- **The key.** A WebCrypto ECDSA P-256 key pair, made on the first call (the first launch, in practice) and kept in IndexedDB (database `fortymm-device-key`, store `keys`, entry `signing`) as the `CryptoKey` objects themselves. The private key is made non-extractable: script on the origin can ask it to sign, but can't read or export it. The core never sees it; it gets the public key and signatures. Every later call, after a reload and with no connection, gets the same key.
- **The public key** is exported uncompressed (65 bytes, `04`) and compressed in `compressedPublicKey` to the 33 bytes (`02` or `03`) records store and the core's `accountId` and `ownPlayerId` take.
- **One key, however many callers.** Creation runs inside the append lock, and looks for a kept key once it holds it. Two calls at once, in one page or in two tabs, get one key.
- **Failures are answers.** `withDeviceKey` never throws for a browser that can't keep a key, and never hands out a key it couldn't keep: `signing-unavailable` (no WebCrypto, as in an insecure context, or no P-256), `storage-unavailable` (no IndexedDB, or it refused to open, read or store, or the browser denied the lock request, as when the person blocks site data), `locks-unavailable` (no Web Locks). WebCrypto failing to export the public key is `signing-unavailable`. Only a callback that throws makes `withDeviceKey` throw.
- **Reading without making.** A screen never asks for the key: it reads this device's user with `loadMe()` (below), which makes nothing.
- **Who signs.** Only what makes records: today the first launch, which signs this device's hello (below); later the journal. Feature code never signs (design 4.3).
- **Honest limit.** The browser deletes the key with the rest of the site's storage (cleared data, a private window closing, Safari's eviction of a site not on the home screen); the next call then makes a new key. Asking for persistent storage is not done yet.
- **Tests.** Compression (against two known points, one of each parity) and the failures when an API is missing, IndexedDB refuses to open or the lock request is denied are in `src/device-key.test.ts`. Everything about the real key (kept and reused across a reload, non-extractable, accepted by the core, signatures that verify with the core, one key for two callers in a page or two tabs, the failures when P-256 or storing is refused, signing after opening with no connection, `store` inside the callback working without waiting on the lock, the lock released after a callback that throws, and the typed failures when the browser blocks site data or WebCrypto can't export the key) is in the browser suite, `e2e/tests/device-key.spec.ts`. No screen signs, so those tests go through a test-only page, `e2e/harness/device-key.html`, which `scripts/e2e-deployments.ts` builds from the app's own modules into a deployment of its own (`harness`); the production build doesn't contain it.

## Records and users on this device

`src/storage.ts` keeps records on the device, and the users minted from them (design section 5, the Web row). It is a small DAO: the rest of the app sees its functions and types, and nothing else opens its database.

```ts
import { loadMe, loadUser, storeRecord } from '../storage.ts'

await storeRecord(hello)     // { ok: true } | { ok: false, reason }
await loadUser(playerIdHex)  // { ok: true, user: User | null } | { ok: false, reason: 'storage-unavailable' }
await loadMe()               // this device's user: the same answer as loadUser
```

- **Where.** IndexedDB, database `fortymm-storage`, version 1: store `records` holds each record's bytes, as signed, keyed by its id (hex); store `users` holds each user, keyed by player id (hex); store `me` holds one entry, `user`, the player id of this device's own user.
- **This device's user.** `loadMe()` reads the `me` pointer and the user it names in one transaction: no lock, no key, no core, so a screen shows it at once. Only code holding the device key writes the pointer, through `withDeviceKey`'s `store`: `store.storeRecord(hello, { me: true })` writes it in the same transaction as the record and its user (if any write fails, none of the three is kept), so the pointer never names a user that isn't stored. A user stored with the public `storeRecord` isn't this device's.
- **No upgrade from before the pointer, on purpose.** A browser profile that kept a `fortymm-storage` from before the `me` store existed (only developers' and previews' profiles) isn't upgraded: `loadMe` and storing with `{ me: true }` answer `storage-unavailable` there (so `/settings` says it can't read this device's storage) until its site data is cleared.
- **The record is the source of truth.** A user is a copy of what a hello says, kept so it can be read by player id, and can always be rebuilt from the records. Its fields come from the shared core's getters, never from parsing bytes in the app: `playerId` (`signerOwnPlayerId`), `accountId` (`signerAccountId`), `username` (`username`, suffix 4), `publicKey` (`introducedKey`), and `unconfirmed`, always true until sync exists (only the server confirms a username).
- **Written together.** `storeRecord` writes the record and every row it mints in one transaction, with strict durability, inside the append lock `fortymm-journal-append`. If any write fails, neither is kept. Storing the same record again leaves one record and one row.
- **Hellos only, for now.** A hello is the only kind that mints a row, and the only kind stored: anything else, a hello whose signature doesn't verify, or bytes that aren't a record, is refused (`not-a-hello`) before storage is opened.
- **The core.** `storeRecord` loads the shared core itself (`loadCore()`); callers pass only the record.
- **Failures are answers.** No function throws for a browser that can't store: `storage-unavailable` (no IndexedDB, or it refused to open, read or write), `locks-unavailable` (no Web Locks), `core-unavailable` (the core didn't load), `not-a-hello`. `loadUser` for a player with no row, and `loadMe` with no pointer, give `user: null`, not a failure.
- **Not yet.** The order records entered (design 5.4's counter), record states (held, acknowledged), and other kinds of record come with the journal. The first launch stores the device's own hello (below), through `withDeviceKey`'s `store`.
- **Tests.** The refusals and the failures when the core, IndexedDB or Web Locks is missing or refuses (`loadMe`'s included) are in `src/storage.test.ts`. What is kept in real IndexedDB (the user a hello mints, after a reload and with no connection; the record and row written together; kept once; none for an unknown player; `loadMe` after a hello stored as the device's own, none for one stored without it, none and nothing made on a fresh device; the pointer, record and user written together) is in the browser suite, `e2e/tests/storage.spec.ts`, through the test-only page `e2e/harness/storage.html` in the `harness` deployment.

### The account settings page

`/settings` (`src/routes/settings.tsx`, the screen `src/components/SettingsScreen.tsx`) shows this device's username. Its loader calls `ownAccount()` (`src/account.ts`), which reads this device's user with `loadMe()`: one read, with no key and no core, so it doesn't wait for the core's WebAssembly. When there is no user yet (a first visit straight to `/settings`, while the launch at startup is still running), it waits for that launch with `startupLaunchSettled()`, up to 5 seconds (`startupLaunchBound`, in `src/first-launch.ts`: a launch takes well under a second; the bound covers a slow connection fetching the core, and a launch held back by another tab keeping the append lock), then reads again. Still no user (the launch failed, or is held back past the bound), the page says there is no account yet, until the next visit; it makes nothing: opening a page never mints an identity; the first launch at app startup does. When storage can't be read it says so; the loader never throws. What the screen shows for each account, and while it reads, is tested in `src/components/SettingsScreen.test.tsx`; how the account is read (reading again after the launch, making nothing) in `src/account.test.ts`, with `loadMe` replaced; the route's wiring (its loader's account reaches the screen, the pending view shows while it reads) in `src/routes/settings.test.tsx`; the page over real storage in `e2e/tests/settings.spec.ts`: after the app's own first launch (the username shown, then after a reload and with no connection, from the same key and the one hello), on a first visit straight to it (shown once the launch finishes; "no account yet" after the bound when another tab holds the lock), and with the core's module held back.

### The first launch

`src/first-launch.ts` gives a device its account the first time the app starts on it (design 4.3, 4.4, 5.4). `main.tsx` starts `launchAtStartup()` in the background, without delaying the first paint: it asks React to render the app first, and no screen waits for the launch except `/settings` with no account yet, bounded (above). The launch can begin (fetching the core) before the page has content; the page doesn't wait for that either.

- **What it does.** It loads the core, then, in one `withDeviceKey` callback (the key made there if none is kept), asks `store.loadUser` for the user of the key's own player id. If there is one, it does nothing. Otherwise it builds a hello (`helloBody`, with 8 bytes from `crypto.getRandomValues` and no clock reading), signs it with the key, converts the signature (`storedSignature`), assembles it, and stores it with `store.storeRecord(hello, { me: true })`, which writes the hello, its user and the `me` pointer together.
- **Every later start does nothing**, and needs no connection. A key kept with no user (a launch that stopped between steps) gets its hello at the next start, from the same key. Two tabs opening at once end with one key, one hello and one user: the lock and the "is there a user?" check inside it.
- **No sync yet.** The stored hello waits for sync, a later task; the user stays `unconfirmed`.
- **Failures leave the app running.** The launch never throws and shows nothing: if the core doesn't load or storage refuses (site data blocked included), no hello or user is kept (the core loads before the key is made, so a failed core leaves no key either), `/settings` says there is no account yet, and the next start tries again.
- **The environment number** in the hello is `environment`, 3 (development, `../core/FORMAT.md` section 4): a placeholder for the developers' stacks and the ephemeral previews, the only environments today. Production and UAT builds will need their own.
- **When it is done**, the app sets a User Timing mark, `fortymm:first-launch`, whose detail is the result (`made`, `kept`, or the failure). The browser suite waits for it (`App.firstLaunch()` in `e2e/pages/app.ts`).
- **Tests.** All in the browser suite, through the shipped app: `e2e/tests/first-launch.spec.ts` (one key, hello and user, and the user the core gives for the key, which `loadMe` then gives; two tabs; a key with no user; a second start storing nothing; the app rendering while the launch is held back by another tab holding the lock, and while the core is still loading; IndexedDB refusing, site data blocked (a Chromium profile with "Don't allow sites to save data", `e2e/pages/blocked-site-data.ts`), and the core not loading) and `e2e/tests/settings.spec.ts` (the username on `/settings`, after a reload and with no connection).

## Opening with no connection

The app is a web page the browser has to download, so it keeps a copy on the device: after one visit with a connection it opens and works with the network off, from a tab or from the home screen. People score matches in sports halls with no signal.

| What | Where |
| --- | --- |
| The service worker | `offline/service-worker.ts` (typechecked with the WebWorker library, `tsconfig.worker.json`) |
| The build step that writes it into the build as `dist/sw.js` | `offline/plugin.ts` (`keepOnDevice()` in `vite.config.ts`, build only) |
| Its registration, in production builds only | `src/keep-on-device.ts`, called from `src/main.tsx` |

- **What is kept.** Every file the build emitted, read from `dist/` once the build is written: the page, every chunk (screens not opened yet too), styles, images, `.wasm` files, and what `public/` copied in. Nothing to list by hand: a new file is kept by the next build.
- **What answers.** A file of the build comes from the kept copy. Loading any other path of the app gets the kept `index.html`, and the router decides what it shows, as the hosting does online. Requests under `/api/` are never answered from the kept copy, not even with the app's page: they always go to the network, and with no connection `/health` says the api can't be reached. No api answer is kept.
- **Updates.** `sw.js` holds a version, a hash of every kept file and of the worker, so any change to the build changes it. The browser fetches `/sw.js` on visits with a connection; a new version installs and waits, and takes over once every page of the app has been closed. A page that is open is never reloaded or changed underneath its user (someone may be scoring a match), so reloading the only open tab still shows the old version. The next opening shows the new one, with or without a connection. There is no "update available" prompt.
- **Development.** The dev server (`web-client:up`) has no `sw.js` and registers no service worker, so hot reload never fights a kept copy.
- **The hosting** must serve `/sw.js` at the root, as JavaScript, with `Cache-Control: no-cache` and never from an edge cache, and never answer it with `index.html`; and serve every kept file, `/index.html` included, as itself, never as a redirect (a browser refuses a redirected response for a page load). The Worker does ("Hosting" below).

## Installing

`public/manifest.webmanifest` (linked from `index.html`) names the app `fortymm` and opens it in its own window (`display: standalone`) at `/`. Browsers offer to install it, and on an iPhone it can be added to the home screen with Share, then "Add to Home Screen". There it opens as its own app, and Safari no longer clears its storage after a week without use.

The icon is `public/favicon.svg`: the design system's logo mark, a flat ball-500 disc (`#FF7A1A`), with "40" in on-accent ink (`#0B0D12`), set in Space Grotesk Bold. The "40" is outlines, not text, since an SVG favicon can't load a web font. `scripts/icon-mark.ts` writes the file: it fetches Space Grotesk Bold from Google Fonts (SIL Open Font License; the font file isn't kept) and reads the two glyphs' outlines itself (`./bin/mise run web-client:exec -- node scripts/icon-mark.ts`). The install icons in `public/icons/` are rendered from `favicon.svg` by `./bin/mise run web-client:icons` (Chromium, `e2e/scripts/render-icons.ts`): 192 and 512 transparent around the disc; a maskable 512 with the disc inside the safe zone on the design system's bg-app (`#0B0D12`); and `apple-touch-icon-180.png` for iPhones, opaque on bg-app. After changing the icon, run the task, look at the PNGs and commit them. The theme colour (`theme-color` in `index.html`, `theme_color` in the manifest) and the splash screen's background (`background_color`) are the page's background, bg-app (`#0B0D12`).

## The theme

Every screen wears the [FortyMM design system](https://claude.ai/artifact/JRzfvUpavyG2qR4nWUrWoA) (an artifact of type Design System): dark only, flat surfaces, orange (`--accent`) only for actions and selection.

| What | Where |
| --- | --- |
| The tokens: colours, type styles, spacing, radii, shadows, font sizes, line heights, font stacks (`--bg-app`, `--fg-1`, `--accent`, `--font-ui`...) | `src/theme/tokens.css`, a copy of the artifact's |
| The three typefaces, Space Grotesk (UI text), Bebas Neue (the wordmark only) and JetBrains Mono (numbers), as woff2, with their SIL Open Font Licenses | `src/theme/fonts/` |
| Where the tokens apply: the font faces, bg-app on `html` and `body` (so it fills the viewport and any overscroll), `color-scheme: dark`, the type roles on `h1`-`h3` and `p`, links, the focus ring and the motion tokens (from the artifact's `colors_and_type.css`) | `src/theme/theme.css`, imported once by `src/main.tsx` |
| The page's colour before the stylesheet loads (no white flash), and the browser's colours around the app | `index.html` (inline `html` style, `color-scheme` and `theme-color`), `public/manifest.webmanifest` |

- **Fonts are files of the build.** `theme.css` points at them, so Vite emits them into `dist/assets/` and the service worker keeps them with everything else: the app never asks a font service, and its fonts load with no connection.
- **Components use the tokens**, never hex values or font names of their own.
- **Re-syncing from the artifact.** `tokens.css` is the artifact's `project/tokens.css` (generated there from `project/tokens.json`) without its `@font-face` rules, which point at the artifact's own font files. To take a new version: read the artifact's `project/tokens.css` (Claude's Artifact tool, `action: "read"`, `paths: ["project/tokens.css"]`), replace everything below the comment at the top of `src/theme/tokens.css` with it, and drop its `@font-face` lines. If bg-app changed, change `index.html` (its inline style and `theme-color`) and the manifest's `theme_color` and `background_color` too: they repeat the colour by hand, and no test checks that they agree. If the artifact adds a font file, convert it to woff2 (fontTools, `TTFont(path).flavor = 'woff2'`), put it in `src/theme/fonts/` with its licence, and add its `@font-face` to `theme.css`. Space Grotesk isn't in the artifact (it loads it from Google Fonts); ours is `SpaceGrotesk[wght].ttf` from [google/fonts](https://github.com/google/fonts/tree/main/ofl/spacegrotesk), converted the same way.
- **`/design-system`** (`src/routes/design-system.tsx`, the screen `src/components/DesignSystemScreen.tsx`) is where each component of the design system is shown as the app builds it, to check against the design system's reference sheet (`../references/design-system/`, "The controls" below). It has its header (the wordmark, "FortyMM" in Bebas Neue, the `scoreboard-display` style, and its title in Space Grotesk), then a section per board of the sheet: so far the controls.
- **Tests.** No test reads styles. How the app looks is proven by screenshots, in the browser suite (`e2e/tests/design-system.spec.ts`, "Tests" below): today the controls. Screenshot tests are only for the design system pages (`/design-system/*`); the theme on the other screens, and the layout, are checked by eye. What the screens show is tested: `/` is blank (`src/components/StartScreen.test.tsx`); `/design-system` has its header and the controls' sections (`src/components/DesignSystemScreen.test.tsx`) and opens with no connection after a visit to `/` (`e2e/tests/offline.spec.ts`).

### The controls

The design system's controls are components in `src/components/`, one per file with its CSS beside it, used by any screen: `Button` (variants primary, secondary, ghost, danger, danger-solid and link; sizes sm, md, lg, xl; icon-only, which must have an `aria-label`; `loading`), `TextInput`, `Select` and `TextArea` (their shared field edge in `field-control.css`), `Field` (a label, one control and help or an error, tying them together with `aria-describedby` and `aria-invalid`), `Checkbox` and `Radio` (native inputs inside their label; shared look in `choice.css`), `Switch` (`role="switch"`), `Tabs` (a tablist, with panels), `SegmentedControl` (a radiogroup, one always on), `FilterChip` and `FilterChips` (toggle buttons, with an exclusive "All"), and `Icon` (the Lucide icons the controls use, inline). `Tabs` and `SegmentedControl` share their selection and keyboard rule in `single-selection.ts`: one stop in the tab order, arrow keys move and select, Home and End.

- **The reference.** `../references/design-system/` holds the design system's reference sheet (its README says how to read the boards). The controls are the "Controls: state matrix" board, `Controls.dc.html`; its stylesheet, `reference.css`, holds the design system kit's `fm-*` rules. Each component's CSS is those rules ported one by one onto our class names and the theme's tokens: a colour is always a token (`--danger` at 55% is `color-mix()` of `--danger`, not a hand-copied rgba), and only sizes the tokens don't have (a button's 40px height) are written in px.
- **On the page.** `ControlsSection` (in `DesignSystemScreen`) lays the controls out as the board does, with the board's headings and the board's `data-testid` on every target (`state-<component>--<state>`, `button-size-*`, `field-*`, `group-*`, `section-*`), so a screenshot of a target can be set beside the same target on the board. In its state matrices, hover, focus and pressed are drawn by `forcedState` (`forced-state.ts`), which a component renders as `data-forced-state` and its CSS styles like the real state, as the board's `.is-hover`, `.is-focus` and `.is-active` do; the matrices' bodies are `inert`. The sizes, field examples and selection groups below them are live.
- **Tests.** What each control does (a click, a key, disabled, its accessible name, a field's description) is its own component test, `src/components/<Name>.test.tsx`, rendered alone; `Button.test-d.tsx` proves an icon-only button needs a name. How each looks is the screenshot suite (below).

## Hosting

The production build is served by a Cloudflare Worker, at its `workers.dev` address only (no custom domain yet).

| What | Where |
| --- | --- |
| The Worker's configuration: its name (`fortymm`, provisional), the build as its static assets (`../dist`), the compatibility date | `worker/wrangler.jsonc` |
| Every rule the hosting applies | `worker/src/index.ts` |
| The deploy, and its credential check | `worker/scripts/deploy.sh`, `worker/scripts/with-credentials.sh` |
| Wrangler, pinned | `worker/package.json` (installed by `web-client:worker-install`, in the `web-client-worker` image) |

**What it serves.** The Worker's code runs first for every request (`run_worker_first`), so every rule is in `src/index.ts`, whatever the platform would otherwise route straight to the files.

- `/api` and `/api/*`: the api's, never the app's page. Forwarded to the api with `/api` stripped (`/api/v1/health` to `/v1/health`), as Vite's proxy does in dev; see "The proxy to the api" below. A deployment without an api answers a plain 404 for every method.
- A file of the build: that file, at its own path. `/index.html` is not redirected to `/` (`html_handling: "none"`): the service worker keeps `/index.html` and answers page loads with it, and a browser refuses a redirected response for a page load.
- Any other path, for GET and HEAD: the app's page, and the router decides what it shows (its own not-found page for an unknown path). A missing file under `/assets/`, `/sw.js` or `/manifest.webmanifest` is a 404 instead. Other methods get a 404 (405 for a file).
- `Cache-Control: no-cache` on the app's page (at any path), `/sw.js` and `/manifest.webmanifest`, so a deployment is seen at once and the browser always checks for a new service worker. A Worker's responses never go through Cloudflare's edge cache.
- `public, max-age=31536000, immutable` on files under `/assets/`, whose names carry a hash of their content. Other files (icons) keep the platform's `public, max-age=0, must-revalidate`.
- `X-Content-Type-Options: nosniff` on everything. Content types come from each file's extension (`sw.js` as JavaScript, the manifest as `application/manifest+json`).
- A `_headers` file can't do this: it doesn't apply to responses the Worker makes, and in `dist/` the service worker would try to keep it.

**The proxy to the api.** Which api a Worker forwards to is its deployment's configuration, the variable `API_ORIGIN` (`https://<host>`, no path). `worker/wrangler.jsonc` declares it empty; `web-client:deploy -- <worker> <api>` sets it for that deployment (`worker/scripts/deploy.sh`, with Wrangler's `--var`), and refuses anything but `https://<host>`. CI's `preview (web-client)` job waits for `preview (api)` and passes its address, so the Worker of pull request N forwards to the api of pull request N (`fortymm-api-pr-<N>` on Cloud Run). The production Worker is deployed without one, since the api has no production address yet (`api.fortymm.com` doesn't exist), so its `/api/*` is a 404; give `web-client:deploy` the api's address in CI's `deploy` job once it has one. To the browser the api is the app's own server, on the app's origin, so the proxy is transparent (`worker/src/index.ts`, `toApi`):

- *What goes to the api:* every method; the path with `/api` stripped, and the query. The rest of the path is appended to the origin as text, so `/api//example.com/x` still goes to the api's host. Every request header but `Host` (the api's own): cookies and `Authorization` too, as Vite's proxy forwards them in dev, so the api sees the same requests in dev, in the stack and deployed. The body, as it streams in.
- *What comes back:* the api's status, headers and body as they are, except that every answer gets `Cache-Control: no-store` (the browser always asks the api; the service worker never keeps an api answer either) and `nosniff`, whatever the api sends, so the api's headers never weaken the hosting's. A redirect to the api's own address (FastAPI builds absolute URLs from its host, e.g. `/v1/health/` to `http://<api host>/v1/health`) is rewritten to the same path under `/api` on the app's origin, so the browser never leaves it. Redirects go to the browser; the Worker never follows them.
- *An api it can't reach* (a refused connection, a name that doesn't resolve): a plain-text 502 at once, never the app's page. An api that answers with an error (a 503 when its database is down) is passed on as it is. The Worker sets no timeout of its own: an api that takes the connection and never answers is waited for as long as Cloudflare allows.

*What is tested.* One thing: the hosted `/health` page shows the api's real health through the Worker (`../e2e/tests/health.spec.ts`), in the stack against `api-release` and on every pull request's preview against its api. That covers a GET with `/api` stripped reaching the api and its answer coming back. The proxy's other rules have no test: other methods, headers, bodies and the query reaching the api, `no-store` and `nosniff` on its answers, the redirect rewrite, a path like `/api//example.com`, the 502 when the api can't be reached, the 404 without an api, and `deploy.sh`'s refusal of an api origin that isn't `https://<host>`.

**Locally.** `./bin/mise run web-client:worker-up` builds the app and serves it from the Worker in the local Workers runtime (`wrangler dev`, the same configuration), forwarding `/api/*` to `api-release` (the api's production image, which it starts with its database), and prints the address; `web-client:worker-down` stops the Worker and `api-release` (`api-db` stays up until `down` or `api:down`). The cross-app suite's `worker` project tests every rule above but the proxy's against it, and its `api-wiring` project the page reaching the api through the proxy (`./bin/mise run e2e`), and `web-client:deploy-check` dry-runs the deployment in `web-client:validate`.

### Deploying

**Each pull request gets a preview.** CI's `preview (web-client)` job runs, once `preview (api)` has deployed the pull request's api, `./bin/mise run web-client:preview -- fortymm-pr-<number> <that api's address>`. That builds the app, uploads it with the Worker (`wrangler deploy`) to a Worker of its own that forwards `/api/*` to that api, then runs the hosting checks (`web-client:hosting-check`) against its address: the hosting's rules, and `/health` showing the api's real health through the proxy. A preview that breaks a rule fails `ci-passed`. If the api's preview fails, the web client's is skipped (and `ci-passed` fails for the api's). The address is in the job's summary (the run's page, Summary) and in a comment on the pull request, beside the api's, updated on every push (CI's `preview comment` job). The checks first wait, up to two minutes, until the address serves this build's `index.html`: a deployment reaches Cloudflare's edge some seconds after `wrangler deploy` returns. Until then a new Worker's address answers Cloudflare's own 404 (`error code: 1042`), and an existing one answers with the previous version. The local Workers runtime has no such delay, so only a deployment shows it. A pull request from a fork or from Dependabot gets no secrets: its preview is skipped, and `ci-passed` doesn't need it. When the pull request closes, merged or not, the `Preview cleanup` workflow deletes its Worker (`web-client:preview-delete`, which refuses any name but `fortymm-pr-<number>`).

**Anyone who can push a branch to this repository and open a pull request from it can deploy a preview with the Cloudflare token**, and so run code of their choosing with it during that job. Pull requests from forks can't: CI runs on `pull_request`, never `pull_request_target`, so a fork's code never gets the secrets.

**A merge to `main` deploys to production.** CI's `deploy (web-client)` job runs on a push to `main` only, after `ci-passed` succeeds: `./bin/mise run web-client:deploy` builds the app and uploads it to the `fortymm` Worker, and runs no checks against it. Nothing is tested against production: the pull request's preview was. Roll back (below) if a deployment must not stay.

It needs two repository secrets (GitHub: Settings, Secrets and variables, Actions, New repository secret). Only the preview, deploy and cleanup jobs read them; without them each fails and says which is missing. The free plan allows 100 Workers per account; previews are deleted when their pull request closes.

- `CLOUDFLARE_ACCOUNT_ID`: the account's ID (Cloudflare dashboard: Workers & Pages, the account ID in the sidebar, or the account's home page).
- `CLOUDFLARE_API_TOKEN`: an API token (dashboard: My Profile, API Tokens, Create Token, Custom token) with one permission, **Account, Workers Scripts, Edit**, and under Account Resources only this account. That is the least that uploads a Worker with its assets and turns on its `workers.dev` address. If a deploy fails for want of another permission, the "Edit Cloudflare Workers" template has everything Wrangler can use, but grants much more (KV, R2, routes on every zone).

The first deploy needs the account to have a `workers.dev` subdomain: opening Workers & Pages in the dashboard once sets one up.

**The address** is `https://fortymm.<account subdomain>.workers.dev`. The deploy job's log prints it, and the dashboard shows it under Workers & Pages, `fortymm`.

**Rolling back.** Dashboard: Workers & Pages, `fortymm`, Deployments, the menu on an earlier version, Rollback. Or, with both credentials in your environment: `./bin/mise run web-client:wrangler -- deployments list`, then `./bin/mise run web-client:wrangler -- rollback <version-id>`. A rollback serves the earlier build at once; phones pick it up like any new version (its `sw.js` differs), at their next opening. The next merge to `main` deploys again over it.

### Trying a branch on Cloudflare before it merges

A pull request's preview does this for you. To deploy the checked-out branch from your own machine instead, to a separate Worker so the one `main` deploys is never touched, use your own token (as above) and account ID:

```sh
export CLOUDFLARE_ACCOUNT_ID=<account id>
export CLOUDFLARE_API_TOKEN=<token>
./bin/mise run web-client:preview -- fortymm-trial https://fortymm-api-trial-89514061125.northamerica-northeast2.run.app
```

The second argument is the api the Worker forwards `/api/*` to: here the api's trial preview (`./bin/mise run api:preview -- fortymm-api-trial`, `api/README.md`), or any api's `https://<host>`. It deploys to `https://fortymm-trial.<account subdomain>.workers.dev`, then runs the same hosting checks against it (deep path, bundle, `/sw.js`, manifest, caching, the 404s, `nosniff`, `/health` reaching the api, opening offline). To run them again later: `./bin/mise run web-client:hosting-check -- https://fortymm-trial.<account subdomain>.workers.dev`. They check the address serves the build in `web-client/dist`, so run them from the checkout that deployed it, with that build in place. To remove the trial Worker: `./bin/mise run web-client:wrangler -- delete fortymm-trial`, or the dashboard: Workers & Pages, `fortymm-trial`, Settings, Delete.

## Tests

| What | Where | Run by |
| --- | --- | --- |
| A screen's behavior: every state it shows, the component rendered alone with the props each state takes | `src/components/<Name>Screen.test.tsx`, next to the component | `web-client:test` (Vitest, Testing Library, jsdom) |
| Its page object | `src/components/<Name>Screen.page.tsx` | used by the test above and by the route's test |
| A loading function or an api call: what each answer becomes (`ownAccount`, `checkCore`, `fetchHealth`) | beside it, `src/<module>.test.ts` | `web-client:test` |
| A route's wiring: its path shows its screen with its loader's data, its pending, error and not-found components, its params, search and redirects | `src/routes/<route>.test.tsx`, next to the route | `web-client:test` |
| Type-level claims (the router's paths; the client's requests, the zod schemas' input and the mocks typed from the document) | `src/**/*.test-d.ts(x)` | `web-client:typecheck` |
| The build step that writes the service worker (`offline/plugin.ts`: every emitted file is kept) | `offline/*.test.ts` | `web-client:test` |
| A control's behavior: what a click or a key does, disabled, its accessible name | `src/components/<Name>.test.tsx`, next to the component | `web-client:test` |
| The layout's behavior: the sidebar's links and current page, the top bar's toggle and brand link, the one `<main>` | `src/components/AppLayout.test.tsx`, `Sidebar.test.tsx`, `TopBar.test.tsx`, through `AppLayout.page.tsx` | `web-client:test` |
| What only a real browser shows about the production build by itself: opening with no connection, a new deployment reaching the device, installability, the shipped app loading the shared core (online and offline), this device's signing key and the records and users kept in IndexedDB (through the test-only pages in `e2e/harness/`), the first launch at app startup, `/settings` after it, how the design system page's controls look (screenshots, `e2e/tests/design-system.spec.ts`), and which parts of the layout show at a desktop and a phone width (`e2e/tests/app-layout.spec.ts`) | `e2e/tests/*.spec.ts`, page objects in `e2e/pages/`, screenshot baselines in `e2e/tests/__screenshots__/` | `web-client:e2e` (Playwright, the last step of `web-client:validate`) |
| How the build is hosted, by the Worker ("Hosting" below): what a person sees (a deep path gets the app; the bundle runs as served; the app opens offline after one visit; `/health` loads the shared core as served) in `../e2e/tests/hosting.spec.ts`, and its HTTP rules (headers, 404s) in `../e2e/tests/hosting-rules.spec.ts` | `../e2e/`, Playwright project `worker` | the stack-wide `e2e` task (CI's stage 2), against the local Workers runtime forwarding to `api-release`; `web-client:hosting-check`, against any address (CI's preview, against the pull request's) |
| Wiring to the api through the Worker's proxy (the hosted page reaches it, and an api answer is never kept: `../e2e/tests/health.spec.ts`), the proxy's one check | `../e2e/`, Playwright project `api-wiring` | the same two tasks |
| The Worker typechecks; its deployment's dry runs; the deploy's credential check; the preview delete's and `web-client:preview`'s refusals | `worker/` | `web-client:deploy-check` (last step of `web-client:validate`) |

The browser suite (`e2e/`) drives the production build served by `vite preview` (`web-client-preview`), from the `web-client-e2e` service, which shares its network, so the app is at `http://localhost:4173`: a secure context, where service workers run. `web-client:e2e` copies the build to `e2e/.builds/current`, makes `e2e/.builds/next` from it (the page's title says "(next deployment)", and `sw.js` is rewritten by the same build step) and `e2e/.builds/harness` (the build plus the test-only `/device-key.html` and `/storage.html`, their files under `/harness/`, with `sw.js` rewritten so it is kept too), and serves `e2e/.site`, which `deploy('current' | 'next' | 'harness')` (`e2e/pages/deployment.ts`) replaces to publish a new deployment. Those directories are gitignored. Specs import `test` and `expect` from `e2e/pages/test.ts`, not `@playwright/test`: its automatic fixture deploys each test's build before the test starts, `current` unless the file says `test.use({ build: 'harness' })`, so no test sees what the one before it left. A test that publishes a deployment mid-test calls `deploy` itself (`offline.spec.ts` deploys `next`). The tests run one at a time, since the server is shared. A test opens a screen with its page object's `goto()` (`await new SettingsPage(page).goto()`, in `e2e/pages/app.ts`), which loads the screen's address directly, the way a typed address, a bookmark, a reload or the home-screen icon does, never through the router of a page already open; each screen's path is written only there. `NotFoundPage.goto()` loads a path the app has no screen for. What an open page does that is no one screen's (its first launch, being kept on the device) is on `App`. A test goes offline with `context.setOffline(true)`.

### Screenshots

How the design system page's controls look is proven by pictures, in the browser suite: `e2e/tests/design-system.spec.ts` opens `/design-system` (`DesignSystemPage.goto()`, then `waitUntilDrawn()`, which waits for the fonts) at the board's width (a 1456px viewport: the board's 1184px of content, plus the app's 16px margins, plus the layout's sidebar, expanded as it starts, 240px), and compares each target of the Controls board, found by its `data-testid` (`DesignSystemPage.target(id)`), with its baseline: every section, every matrix row and each of its cells, the button sizes, the field examples and the selection groups, one test per section, row or group, each target a soft assertion so a failure names every target that changed.

- **Baselines** are committed, `e2e/tests/__screenshots__/design-system.spec.ts/<data-testid>.png` (`snapshotPathTemplate` in `e2e/playwright.config.ts`), one per picture, with no platform in the name: the suite only runs in its container (`dev/e2e`, the pinned Playwright image), whose Chromium, Linux and fonts are the same in CI and on a laptop. Measured: two runs give the same pixels, and so do the container on an arm64 laptop and on CI's amd64. With the layout, one run in five gave `section-fields` 21 pixels at most 4/255 off (below the comparator's colour threshold, so it passes); the other baselines were the same in every run.
- **Deterministic.** Animations and transitions finished, no caret (`animations: 'disabled'`, `caret: 'hide'`), fonts loaded before a picture, a fixed viewport, nothing from a clock or a random generator on the page.
- **Tolerance.** `maxDiffPixelRatio: 0.0001`: about a pixel in a matrix cell. Nothing differs between runs or machines, and the smallest change seen to fail (a field's corners 2px rounder) is 12 pixels in a cell; a larger ratio lets a large picture hide a change (at 0.1%, a field label set bold passed). One blind spot no setting removes: Playwright's comparator (pixelmatch) ignores pixels it takes for anti-aliasing, so a change of about one pixel at a curved edge passes (a radio's dot 10px to 8px, a checkbox's corner 4px to 2px); 10px to 6px fails.
- **Changing a control's look**, or adding a target: run `./bin/mise run web-client:e2e -- --update-snapshots` (arguments go to `playwright test`; add `design-system` to run that spec only), which writes the baselines that changed (`--update-snapshots=all` writes all of them), then look at each changed picture beside the same target on the board before committing it. In CI a missing baseline fails; on a laptop the run writes it and passes, so look at it too. A failed run's report (`e2e/playwright-report/`, and CI's `validate-report-web-client` artifact) shows the expected, actual and diff pictures.
- **Against the board.** A baseline is only as right as the look it froze, so each one was compared with the board when it was made: render `references/design-system/Controls.dc.html`'s markup with `reference.css` (and the app's font files) in the same container, screenshot the same `data-testid`s, and set them side by side. The board needs no script for that: its loops are empty.
- **Where on the page matters.** Chromium anti-aliases a glyph's or a curve's edge differently depending on where on the page it is drawn, even moved by whole pixels. When the layout moved the controls 240px across and 65px down, every baseline kept its size, but 66 of the 108 changed at edges (the most, 97/255 on a few pixels of scaled text; a focus ring's corners; the select's faint fill), and Playwright's comparator still passed 107 of them. When the top bar then shrank to 56px (the controls 8px higher), 18 changed again, on 2 to 41 pixels each, at most 27/255. Each time they were written again and compared pixel by pixel with the old ones, and by eye: the same pictures. So anything that moves the design system page's content (the layout, its margins) rewrites some of its baselines; compare them with the old ones, not only with the comparator.

Screenshot tests are only for the design system pages (`/design-system/*`), by the user's choice: "let's ditch screenshot tests anywhere except the design system pages, they are fragile" (2026-11-14; the rule is in `CLAUDE.md` here). The layout's looks are pinned by no test; `e2e/tests/app-layout.spec.ts` checks only which parts its breakpoint shows. The design system spec's colour threshold is Playwright's 0.2: pixelmatch counts a pixel as changed when its YIQ distance from the baseline's is over 35215 × threshold², 1409 at 0.2, so a change between the dark surfaces (bg-panel and bg-app are 25 apart) or a hue change at the same brightness can pass there.

The cross-app suite drives the Worker in the local Workers runtime (`web-client-worker`), forwarding `/api/*` to `api-release` (the api's production image, with its database), for the hosting's rules and the api wiring.

A component test renders the screen alone; a route test mounts the app at a URL. Both use the screen's page object, `src/components/<Name>Screen.page.tsx`, which has two kinds of method:

- `render(props)` renders the screen component alone, with the props the test gives it, through `renderScreen(...)` in `src/test/render-screen.tsx`: a bare router of its own, because `<Link>` and `<Await>` need one, and none of the app's routes, loaders or URLs. A screen whose data arrives later takes promises, and the test settles them when it wants the answer to arrive:

  ```tsx
  const page = new HealthScreenPage()
  page.render({ health: health.promise, core: Promise.resolve(coreLoaded) })
  expect(await page.checking()).toBeVisible()
  health.settle({ status: 'healthy' })
  expect(await page.healthy()).toBeVisible()
  ```

- The rest only find elements, by role and accessible name (`heading()`, `linkToStart()`). They work wherever the screen is mounted, so a route test uses them too.

A route test mounts the whole app at the route's URL with `renderRoute(path)` (`src/test/render-route.tsx`: the real route tree and router configuration, with an in-memory history), replacing only what the loader reads at a contract (MSW for the api, `vi.mock` for storage), and checks the wiring with the screen's finders:

```tsx
server.use(healthy())
renderRoute('/health')
expect(await new HealthScreenPage().healthy()).toBeVisible()
```

The test does any interactions itself, with user-event, so they read in its body: `const user = userEvent.setup()`, then `await user.click(await page.linkToStart())`.

### A call to the api, in tests

[MSW](https://mswjs.io/) stands in for the api, at the network level, so the client and everything above it run for real. `src/test/setup.ts` starts the server (`src/test/api/server.ts`) once per file, resets its handlers after each test, and fails any test that sent a request no handler answered. There are no default handlers: each test says how the api answers first. A call's own test proves what each answer becomes (`src/api/health.test.ts`); a route test uses one answer to prove its loader's wiring:

```tsx
server.use(databaseUnavailable())
expect(await fetchHealth()).toEqual({ status: 'database-unavailable' })
```

Handlers live in `src/test/api/<resource>.ts`, one function per way the api can answer. Write them with the `http` from `src/test/api/server.ts` ([openapi-msw](https://github.com/christoph-fricke/openapi-msw)) and `response(status).json(body)`. Path, status and body are then checked against the document, so a mock can't return what the api doesn't send. It matches the URL the browser really requests (`/api/v1/health`), while you write the api's own path (`/v1/health`). For an answer the document doesn't declare on purpose (a network error, an HTML page from a misrouted host), use `response.untyped(...)`.

`renderRoute()` doesn't wait for the route's loader, so a test can see the pending state (the router shows a `pendingComponent` only after the loader has run for its `pendingMs`, a second by default, so that test waits longer than a finder: `src/routes/settings.test.tsx`). Every finder is a `findBy*`, which waits.

Don't add action methods (`clickCounter()`) to a page object. The route generator ignores `*.test.*` and `*.page.*` files in `src/routes/` (`tsr.config.json`).

Lint's fast-refresh rule (`react/only-export-components`) is off in `src/routes/`: a route file exports `Route` next to its tiny wrapper component by design, and the router plugin handles hot reload for it.
