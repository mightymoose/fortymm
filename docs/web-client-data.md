# web-client data, signing and offline

## API client

`src/api/client.ts` exports `api`, an openapi-fetch client typed by the
generated schema, with base URL `/api`: `const { data, error } = await
api.POST('/v1/session', { headers: { 'Content-Type': 'application/json' } })`.
openapi-fetch sends no `Content-Type` for a request with no body. The API
answers 415 to such a `POST`, so a bodyless `POST` sets it itself. `createApiClient()` builds one with other options (e.g.
an absolute base URL in tests). In production the Cloudflare Worker forwards `/api/*`
the same way (see Deploy). The dev server's proxy target defaults to
`http://api:8000` and can be overridden with `API_PROXY_TARGET`.

Components fetch through TanStack Query. `src/api/queries.ts` holds the query
options, one function per request, each taking the typed client, e.g.
`useSuspenseQuery(sessionQuery(api))`. Each `queryFn` calls the client and
throws an `ApiError` with the status when the response has no data.
`createQueryClient()` makes the app's `QueryClient`. It retries a query only
after a network error or a 5xx, which can pass. A 4xx comes back the same.
A retry after a lost `POST /v1/session` response can leave one unused guest
account, which is an accepted cost. `createAppRouter()` puts the client in the router context as `api`,
with the `QueryClient` as `queryClient`, and wraps the router in a
`QueryClientProvider`.

A component that loads data reads it with `useSuspenseQuery`, inside its own
`QueryBoundary` (`src/components/QueryBoundary.tsx`).
[.claude/rules/loading-and-errors.md](.claude/rules/loading-and-errors.md)
says why. The boundary puts `Suspense` inside the `ErrorBoundary` of
`react-error-boundary`, inside TanStack Query's `QueryErrorResetBoundary`.
While the data loads, it shows its `skeleton`. Build the skeleton from
`.fm-skeleton` blocks in the shape of the content. The kit's skeleton is
static, because the design system removed shimmer. If the request fails, the
boundary shows an `fm-alert--error` with `role="alert"`. `classifyFailure()`
in `src/api/errors.ts` sorts the failure, and `failureMessages` there gives
its title and sentence. `ErrorPage` uses both too. After a 429, the alert
also shows the time from `Retry-After` (`RetryTime`). Its Try again resets the boundary, so the query
fetches again. A caller can add more actions, such as a link to Home. One
boundary wraps one loading component, and the component's file exports
them together. The skeleton may be `null` only when the component usually
renders nothing, such as Home's reminder. The root route's error page stays
as the safety net for what no boundary catches.

`sessionQuery` sends `POST /v1/session` and returns the account, with its
player. Pages read the account from it. It passes no abort `signal`. An
aborted request still starts a guest account on the API, but the browser
drops its cookie, so the query would start another one. The `_authenticated`
route's loader waits for the session (`ensureQueryData`). The loader stays in
the entry chunk, so the request runs while the page's chunk downloads. The
router shows the page only once the session has answered and the page's
chunk has loaded. Until then it shows the route's `pendingComponent`,
`LoadingScreen` (`src/components/LoadingScreen.tsx`), if the wait passes
`SHOW_AFTER_MS` (300ms, the route's `pendingMs`). So a fast load shows the
page with no loading screen. Once shown, the loading screen stays up for at
least `MIN_SHOWN_MS` (900ms, `pendingMinMs`). Then the page replaces it in
one frame, with no fade. A navigation to an authenticated page waits for the
session the same way. `sessionQuery` never goes stale, so the
session starts once per page load, and coming back to an authenticated page
doesn't show the loading screen again. If the session fails after the
retries, the root route's error page shows (see Error pages). The web-client no
longer calls `/v1/health`.

`sessionQuery` saves each account it gets in `localStorage`
(`src/api/savedSession.ts`), so a page load with no network can still show
the authenticated pages. It is only what the pages show. The session itself
is the cookie. With a saved account, a load whose request gets no response,
or a 502, 503 or 504, shows the saved account at once. A load whose request
takes `OFFLINE_AFTER_MS` (2s) shows it then. The request goes on. Its answer
replaces the saved account in the query. A request that never got through
starts again on the window's `online` event. TanStack's `onlineManager`
can't tell, because it starts online and a page that loaded offline never
saw an `offline` event. Any other failure, such as a 500 or a 429, shows the
error page as before. With nothing saved, every failure does. The query's
`networkMode` is `always`, so it never pauses while TanStack thinks the
browser is offline. `logout()` forgets the saved account once the API has
ended the session.

A match that the API made opens offline from its URL. Its scoring
fragment always holds its details, from the first draft on (see
Routing). Nothing else saves a match. Making a match needs a
connection, and nothing queues it.

Each request function in `queries.ts` goes through `send()`. It throws
`ApiUnreachable` when no response came back, and `ApiError` when the
response isn't ok. A bodyless `POST` or `DELETE` sends `JSON_HEADERS`.

`logout(api)` in `queries.ts` sends `POST /v1/auth/logout`, with the
browser's signing key id if it has one (see Signing keys), and returns
`data.logout_url`. `useSignOut()` (`src/pages/useSignOut.ts`) runs it
through `useMutation`, for `UserMenu`. On success, it
calls `leavePage()` (`src/leavePage.ts`), which loads the URL with
`window.location.assign`. `reloadPage()` in the same module reloads the
page, for the update notice. jsdom's `location` can't be spied on, so
tests `vi.mock` that module. If the request fails, the menu
says so and offers Sign out again.

## Signing keys

Each browser holds a P-256 signing key, which signs results in the format
of `api/signed-results/README.md` (see Signed match results and Signing
keys under api). `src/signing/` holds the codec and the key. The signing
page and the queue of signed results come with #195.

- The codec is pure, with no app imports. `cbor.ts` encodes and strictly
  decodes the format's CBOR items, the `Cbor` union. A map is a `Map`, so
  the integer key `1` and the text key `"1"` stay apart. `result.ts` holds
  `MatchResult` and the payload, `envelope.ts` the COSE_Sign envelope and
  `Signer`, `cose.ts` the COSE_Key, the kid and the registration proof, and
  `text.ts` the QR text and the link. Every refusal is `Malformed`. The
  client never verifies a signature. The API does.
- `appendSignature()` signs the received payload bytes and never encodes
  the payload again.
- Byte checks use `ArrayBuffer.isView()`, not `instanceof Uint8Array`.
  Under jsdom, the arrays that TextEncoder, WebCrypto and IndexedDB make
  come from another realm.
- `deviceKey.ts` keeps the key in the IndexedDB database `fortymm-signing`,
  store `device-key`, as one record under `device`: the non-extractable
  `CryptoKey`, the COSE_Key and the kid. It stores no account and no
  "registered" flag.
- `sessionQuery` calls `registerDeviceKey()` after each `POST /v1/session`
  answer, without waiting, so the key never holds up the loading screen.
  It makes a key if there is none, as after Safari deletes the site's
  storage, and registers it with a proof for the session's account. The
  API answers 200 for a key the account owns. A 409, or a 200 with
  `revoked_at`, makes a new key and registers it, once. Any other failure
  waits for the next session answer. It never throws.
- Every write is one readwrite transaction that reads the record and
  writes only if it is still the one it read. So two tabs keep one key,
  and a registration that a sign-out overtook makes no new key.
- `logout()` takes the key out of storage (`takeKey()`), then sends its
  id as `signing_key_id`, so the next account gets a new one. A
  registration still in flight then finds no key to replace. It also sets
  a `sign-out` record beside the key, which every tab shares: a count and
  the time the running sign-out started. Every key write checks it in the
  same transaction. No tab stores a key until the logout answers, nor one
  whose making started before the last sign-out. So no key stays live on
  the account that signed out. A tab closed mid-logout leaves the time set,
  so it stops counting after `SIGN_OUT_MS` (1 minute). A failed logout
  puts the key back, unless another key was stored meanwhile. With no
  key, or no IndexedDB, it sends no body, and the sign-out still works.
- `signWithDeviceKey()` gives a `Signer` with the key, or null.

## Error pages

The root route (`__root.tsx`) has `errorComponent: ErrorPage` and
`notFoundComponent: NotFoundPage` (`src/pages/ErrorPages.tsx`). Other routes
set neither, so every error and unknown path reaches the root. The page
replaces the whole app, with no `AppShell`. Each page is an `ErrorScreen`
(`src/components/ErrorScreen.tsx`): the loading screen's wordmark, a title,
a sentence and the fixes. The root route is never code-split, so the pages
are in the entry chunk and still show when the network is down.

A query throws `ApiError` (`src/api/errors.ts`) when the API answers without
data. It carries the status and the time from `Retry-After`. A query throws
`ApiUnreachable` when no response came back. `ErrorPage` reads them:

- `ApiUnreachable`, 502, 503 or 504: "Can’t reach FortyMM".
- 429: "Wait a minute, then try again", with the time from `Retry-After`.
- Anything else: "Something went wrong".

"Try again" reloads the page.

## Service worker

A production build has a service worker, `/sw.js`, which caches the app so
it loads with no network, as in a hall with no signal. `vite-plugin-pwa`
writes it with Workbox (`VitePWA` in `vite.config.ts`).
`createAppUpdate()` (`src/serviceWorker.ts`) makes the `AppUpdate` that
registers it after the page loads, only in a build, so the dev server and
the tests have none. `main.tsx` makes one and puts it in the router
context.

- It precaches every JS, CSS, HTML, SVG and font file of the build, about
  940 KB. So a navigation to a route whose chunk hasn't loaded yet never
  waits on the network.
- A navigation gets the precached `index.html`, except under `/api/`. Those
  navigations, such as sign-in and its callback, go to the Worker.
- It caches no API response. The authenticated pages start from the
  account that the last session saved (see API client). So offline they
  work in a browser that loaded the app online once. A browser with nothing
  saved shows "Can’t reach FortyMM".
- A new version waits until every tab of the old one has closed, or until
  someone presses Reload. It never calls `skipWaiting` on its own, which
  would delete the precache that an open tab still loads its chunks from
  (#153). The API never breaks `/v1`, so an old version keeps working.
- A tab that stays open learns of a new build three ways. A worker that
  waits when a controlled page loads. A worker that starts installing
  (`updatefound`) while another is active, in any tab. And a controller
  change, when another tab's Reload let the new worker take over. An
  uncontrolled tab (a first visit, a Shift-reload) ignores a worker that
  already waited: it loaded its build from the network, most likely the
  very one that waits. The first install ever has no active worker and
  says nothing.
- It tells the person only once the install finished (`installed`). Then
  every file of the new build is in the precache, so Reload needs no
  network. The tab's phase is `UpdatePhase` (`none`, `ready`, `dismissed`,
  `reloading`), moved by the pure `transition()` table and read with
  `useSyncExternalStore`.
- `UpdateNotice` (`src/pages/UpdateNotice.tsx`) shows "FortyMM has been
  updated." with Reload and Dismiss, as an info toast pinned in the toast
  region (`ToastProvider`'s `pinned`), so it stays under any toasts until a
  press. `Root` renders it, so it shows on every page, the public ones
  included, and above the tab bar below 900px (#150). After Reload the
  button reads "Reloading…" and Dismiss goes.
- Nothing reloads without a press. Reload posts `{type: 'SKIP_WAITING'}` to
  the waiting worker and reloads on the worker's next `statechange`. A
  plain reload before that serves the old build again, because the old
  document is still a client during the navigation. With nothing waiting,
  because another tab already reloaded, it reloads at once. A second
  press changes nothing.
- When one tab reloads, every other tab of the old build gets
  `controllerchange` and shows the notice, dismissed or not. Its precache
  is gone, so its next unloaded route goes to the network (#153). It never
  reloads by itself: the person may be mid-way through a result.
- Dismiss hides the notice for the page. A later deploy stays hidden. A
  controller change shows it again.
- The browser checks `/sw.js` on full navigations, which a TanStack
  navigation isn't. So the tab calls `registration.update()` when it
  becomes visible and every `UPDATE_CHECK_MS` (1 h), only while visible and
  `navigator.onLine`. A check that fails is dropped, with nothing logged,
  so a hall with no signal sees nothing.
- The rest of #153 stays open: a CSS chunk that fails to load after a
  takeover reaches `ErrorPage`, and the Worker answers a missing
  `/assets/*` with the app's `index.html`. The notice shrinks the window,
  because the person hears before they navigate.
- `AppUpdate` reads `navigator.serviceWorker` through the narrow types
  `ContainerLike`, `RegistrationLike` and `WorkerLike`, which the fake in
  `src/test/fakeServiceWorker.ts` also fits (see Tests). `reloadPage()` in
  `src/leavePage.ts` does the reload. The app doesn't use
  `virtual:pwa-register`. That module registers at once rather than after
  `load`, reloads every tab that saw the prompt unless told not to, raises
  `onNeedRefresh` twice per update, and stubs to a no-op under Vitest.

