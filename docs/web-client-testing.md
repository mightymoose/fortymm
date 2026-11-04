# web-client tests

## Tests

Vitest is configured in the `test` block of `web-client/vite.config.ts` (jsdom
environment). `web-client/src/setupTests.ts` loads the jest-dom matchers,
starts the mock API, and cleans up rendered components and `localStorage`
after each test, so a saved session doesn't leak into the next test. It
loads `fake-indexeddb`, and gives each test a new `IDBFactory`, so a
signing key, or a registration still in flight, doesn't leak either. It
also drops the demo server's requests in flight and forgets every unsent
board. Tests live next to the code as `*.test.tsx`.

Tests go through page objects in `web-client/src/test/pages/`. A static async
`render()` renders the app's router at the page's path (via
`src/test/renderRoute.tsx`, using a memory history) and returns the object,
whose getters query `screen` on each access (e.g.
`(await HomePage.render()).title`). Page objects expose elements located by
accessible role; assertions stay in the tests. The design system page has no
link to it, so `navigate()` on a page object goes to another page through the
router, as a link would.

Unit tests mock the API with MSW. `src/test/server.ts` holds the mock server
and its default handlers, and `setupTests.ts` starts it. An unhandled request
fails the test. A test overrides a handler with `server.use()`, and the
override resets after the test. Type each mock body with the schema's type,
e.g. `components['schemas']['SessionResponse']`. The default handler answers
`POST /v1/session` with `sessionResponse`, a guest account whose player is
`excited egret 387`. Another default handler answers `POST /v1/auth/logout`
with `logoutResponse`, and another answers `GET /v1/account/players` with
no players. `listedPlayer()` makes a player for the players list, with no
matches. `mockVerifiedAccount()` signs the mock API in as a verified
account with the players it gets. One of them must be `self`, and their
order is the order the API made them. It answers "Is this you?" as the API
does, with `meta`, a merge into the older player and `same_as`. On a
closed question it changes nothing and returns `already_answered`, except
that `not_mine` gets a 409. It returns the answers it got, and
`answerInAnotherTab()`, which answers a question without the page
knowing. `failAnswers` makes every answer fail with a 500. It refuses a merge of
two players who played each other with the API's 409, and
`playersChange()` replaces its players.
A default handler answers `POST /v1/account/signing-keys` with a live
key. `mockSigningKeys(answers)` records each registration and answers
with `answers` in order, each a `KeyAnswer` (`live`, `revoked` or
`taken`, a 409), then `live`. With `hold`, each answer waits for
`release()`. A default handler answers `GET /v1/matches/opponents` with
no players. `mockMatches()` gives the session's account `matches.create`.
It answers the recent opponents with `recent`
and a search from `everyone`, and records each `POST /v1/matches` in
`creates`. It answers it with `create`: `created`, `{ refused: title }`
(a 422, or `status`) or `unreachable`, which a test can change. A
created match answers 201 with its id, and a second create of that id
200. `recentFails` makes the recent opponents answer 500 while it's set, and
with `holdRecent` they wait for `release()`. A default handler answers
`POST /v1/matches/{match_id}/approvals` with a 201. `mockApprovals(answer)`
records each check's match id and envelope, and answers `accepted`,
`{ refused: title }` (a 422) or `unreachable`. A test can change its
`answer`, and with `hold` each answer waits for `release()`.
`src/signing/vectors.test.ts` runs the README's signer
checks K1-K3, V1-V7, R1-R2 and I2 over every vector in
`api/signed-results/vectors.json`, and `src/signing/deviceKey.test.tsx`
tests the key through the app.
`PlayerReviewPage` renders `/review-players` by default, or Home with or
without `signed_in=1`. Its `clickTwiceAtOnce()` clicks a button twice before React
renders again, as a quick double click can.

`mockAdmin()` signs the mock API in as the verified account first in its
`accounts`, and answers the admin routes from the state it gets, as the
API does. The session's `permissions` come from that account's roles and
the default role, so a write can change them. It counts each permission's roles and each
role's accounts. It refuses a taken role name or permission key, a
built-in permission's delete, any write that leaves no account with
`account_roles.manage`, a revoke without `signing_keys.revoke` or of an
unknown key, and a delete, a grant or an administrative permission of the
default role, with the API's titles. Its `signingKeys` are every account's
keys, guests' too. It answers 415 to a write without a JSON
`Content-Type`, a bodyless `POST` too. It returns the `state`, which a test changes
as another tab would, and the `writes` it got. `builtInPermissions`,
`administrator` and `userRole` are the rows the migrations make. It also answers an
account's page. `holdAdmin(list)` holds a list's responses, and
`failAdminOnce(list, status)` fails the next one. A `list` of
`accounts/<id>` names an account's page. The default handlers answer the
admin lists with nothing. `AdminPage` renders `/admin`, and
`AdminPage.renderAccount(id)` an account's page. Only the open tab's panel
shows, so a test opens a tab first.

`ScoreGamePage` renders the scoring page, at `/matches/demo/scores/game/1/edit`
by default, or at any path with a fragment. It types scores, saves,
clears and submits them, and reads the strip, the tally, the feedback,
the notices and the URL's fragment. A press waits until the URL changes
or an alert shows, because a save hashes the result it corrects first.
`href` includes the fragment, and `close()` unmounts the page, so a test
renders `href` again as a reload does. `waitForKey()` waits for this
browser's signing key before a submit. `settle()` also waits until the
strip isn't `aria-busy`, so the sync has stopped sending and pulling.
`switchNetwork()` sets the demo network, `otherDeviceSyncs()` puts
another device's board on the demo server, `serverBoard` reads it, and
`slotSync()` reads what a screen reader hears about a game's sync.
`gameCount` is how many games the strip shows, the match's best of.
`AwaitingValidationPage` wraps the router after a submit, or renders the
submission page at a path with its envelope, and finds its link, QR code
and the link back to the scores.
`AcceptResultPage` renders a link's path and fragment, approves the
result or goes to edit the scores, and reads the game scores table, the
approval status, the check with FortyMM and the URL's fragment.

`NewMatchPage` renders `/matches/new`. It picks and changes the
opponent, searches, sets the match length and rated, presses Start
match, and reads the recent opponents, the search's players, the
summary and the alerts. `findAlert()` matches an alert by its text,
because a `<p role="alert">` takes no name from it.

`HomePage.render({ path })` renders the app at another path, such as one
with a query. `homePage.href` is the router's current path and query, so a
test can check what `SignInErrorAlert` left in the URL.

`renderRoute` gives each render its own `QueryClient` with retries off and an
API client with base URL `API_BASE_URL` (`http://localhost/api`), because
Node's `Request` rejects a relative URL. It loads the route before it
renders, and an authenticated route's loader waits for the session, so the
page is on screen when `render()` resolves. To test the loading screen, hold
the session response with `holdSession()` from `src/test/server.ts` and
render with `waitForLoad: false` (see `src/components/LoadingScreen.test.tsx`).
The router times `pendingMs` with `Date.now()`, so that test fakes `Date`
with the timers. It loads the page's chunks once first, because they load
in real time while the fake clock stands still. To test a skeleton, hold the players
response with `holdPlayers()`. `failPlayersOnce()` fails the next players
request, for a boundary's error. `failSession()` makes every session
request fail with no response, as offline. `src/api/savedSession.test.tsx`
loads Home once to save the account, then loads it again with the session
failing or held. React keeps a Suspense fallback up for a
moment after the data comes, so wait for the content with a `find*` query. `DesignSystemPage.render()` never
waits for the session, because the page doesn't start one.
`src/api/queries.test.ts` checks the retry rule through `createQueryClient()`. `renderRoute` calls
`router.load()`, which also loads the route's chunk. A navigation after the
render can load another chunk. So `PlayerReviewPage.findQuestion()` waits
for the review's heading after Home sends the browser there.

`renderRoute` also takes `appUpdate`, an `AppUpdate` (see Service worker)
around a `FakeServiceWorkerContainer` from `src/test/fakeServiceWorker.ts`.
`HomePage.render()` and `DesignSystemPage.render()` pass it through. Without
one, the router gets an `AppUpdate` with no service worker, so no test sees
the update notice by accident. The fake plays the browser's objects, as much
of them as `src/serviceWorker.ts` reads. `deploy()` installs a new worker
that waits. `startInstall()` and `finishInstall()` split that, for a worker
still downloading. `firstInstall()` is a browser's first worker, which takes
over at once. `takeOver()` lets the waiting worker take over and fires
`controllerchange` on a controlled tab. Its workers record the messages the
page posts, and its registration's `update` is a spy. `UpdateNotice`
(`src/test/pages/UpdateNotice.ts`) reads the notice on any page. A test of
anything that reloads or leaves the page mocks `src/leavePage.ts` with
`vi.mock('../leavePage')`, which makes `leavePage` and `reloadPage` spies.

## End-to-end tests

The Playwright suite lives in `web-client/e2e/` (`*.spec.ts`, excluded from
Vitest) and is configured in `web-client/playwright.config.ts`. It runs in the
`playwright` Compose service: the official Playwright image, which ships the
browsers, sharing the `dev` service's network so the dev server is on
`localhost:5173`. Keep the image tag in `compose.yaml` in sync with
`@playwright/test` in `package.json` (pinned exactly).

Specs import `test` and `expect` from `e2e/fixtures.ts`, which provides page
objects (`e2e/pages/`) as fixtures: `test('...', async ({ homePage }) => ...)`.
As in the unit tests, page objects expose role-based locators and actions like
`goto()`, and the specs do the asserting.

`e2e/session.spec.ts` runs against the real API. It checks that a page load
sends one `POST /v1/session`, that a reload keeps the account, and that a new
browser context gets another. So it also checks that Chromium keeps the
`__Host-` cookie, which is `Secure`, over `http://localhost`. `home.spec.ts`
holds the session request with `page.route()` to show the loading screen.

`e2e/sign-in.spec.ts` signs in through the dev server's `/oidc` proxy and
the mock's sign-in page. It has one test for each outcome of
`resolve_login()`, and one each for a guest and a verified browser whose
sign-in another tab overtook, which must show `failed`. Each test reads the
account from `POST /api/v1/session`
with the page's cookies. The `SignInPage` page object returns to
`/design-system`, which starts no session, unless the test passes
`returnTo: '/'`. Each run makes a new `sub` and email, because the dev
database keeps its accounts.

`e2e/adoption.spec.ts` signs in back to Home. No player has played, so no
sign-in asks "Is this you?", and Home stays on `/`. The VerifyInPlace test
checks that the topbar shows the guest's player after a person's first
sign-in. The AdoptGuest test signs the same person in from a second guest.
It checks that the topbar shows the account's player, and through
`GET /v1/account/players` that the account has only that player. The
Vitest unit tests cover the "Is this you?" page.

`e2e/sign-out.spec.ts` opens `/`, picks Sign in from the account menu and
fills the mock's form with `SignInPage.completeSignIn()`. It lands back on
`/` as a verified account, with the guest's player, signs out and ends on
`/signed-out`. Then Play as a guest opens `/` as a new
guest account. It checks the signing key on the way. After the first
load, `GET /v1/account/signing-keys` lists one live key, the one in
IndexedDB (`HomePage.storedKeyId()`). The logout sends that key's id,
and IndexedDB has no key after it. The new guest registers a different
key. `HomePage.keyRegistered()` waits for a registration. The mock answers 405 to the
logout URL. So the spec answers that navigation with `page.route()`, a 302
to its `returnTo`. The API builds `returnTo` from the browser's `Host`, so
in the e2e suite it is `http://localhost:5173/signed-out`. A second test
signs a guest out from the account menu, through its dialog, to
`/signed-out`. A third signs in again from `/signed-out`, and checks that
the account keeps its one player.

`e2e/admin.spec.ts` signs in as `mightymoose@fortymm.com`, whom the
migration makes an administrator. On `/admin` it creates a role with a new
name, because the dev database keeps its roles, then deletes it. Then it
opens its own account's page from the Accounts tab, and checks that it
holds Administrator. A second test does the same at 390x844, where the
sidebar is a tab bar, and checks that the toast sits 24px above the bar
(#150).

`e2e/new-match.spec.ts` starts a second guest account through the API.
It signs in as `mightymoose@fortymm.com`, who holds `matches.create`,
searches for that guest's player on `/matches/new`, makes a best of 3 against it
and lands on game 1 of the scores, with a strip of 3 games. Then it
aborts every request under `/api/v1/matches/` and reloads. The scores
still open, from the fragment, and the page sent no such request.

The suite counts about 29 guest accounts and sign-ins with no session,
under the limit of 30 a minute.

The design system page is a copy of the reference's component gallery
(`references/design-system/ui_kits/components/index.html`). It has one
component per gallery section, in `src/pages/designSystem/`
(`ButtonsSection`, `FieldsSection` and so on). Each section and example
carries the gallery's `data-testid` (`section-actions`, `ex-variants`).

The app also has the gallery's screenshot test mode (`src/testMode.ts`, see
the gallery's `TESTING.md`). `?test` turns off transitions, animations and
the text caret. `?test&only=<testid>` shows one element alone, flush top-left
with 24px padding. `<html data-fm-ready="true">` marks the page ready. The
mode's rules are in `kit.css`. Components read `isTestMode()` for the
mode's behaviour, such as toasts that stay until dismissed.

So one set of page objects serves both pages. `GalleryPage` holds the page
chrome, `goto(only?)`, and one object per section in
`e2e/pages/designSystem/`, found by test id. `DesignSystemPage` opens the
app's page, and `ReferenceKitPage` opens the gallery from disk.

Screenshot tests use `toHaveScreenshot`; their baselines live next to the spec
in `e2e/<spec>-snapshots/` and only match when taken in the `playwright`
container, so regenerate them there (`docker compose exec playwright npx
playwright test --update-snapshots`, with the stack and dev server up as in
`web-client:e2e`). `design-system.spec.ts` compares the app's page with the
gallery. Each section has one journey test. The journey opens each section
and example with `goto('<testid>')` and takes its screenshots on the app,
then the same screenshots on the gallery, each in its own `test.step`. The
two pages share each png, so they must render identically. The checks are
soft, so one mismatch doesn't hide the rest. The journey reaches hover,
focus and open states through the real UI on both pages. The header has its
own pair of tests, with the app's title swapped into the gallery's.

An update run writes the png from whichever page it checks last, and it
never fails. After `--update-snapshots`, run the suite again without the
flag. Only that run proves that the app matches the gallery.

`e2e/reference-styles.spec.ts` fails if `src/styles/` stops matching the
reference (see Styles).

Every run records a trace: `web-client/test-results/<test>/trace.zip` (open
with `npx playwright show-trace` or https://trace.playwright.dev) and an HTML
report in `web-client/playwright-report/`.

### Post-deploy suite

`web-client/e2e/deployed/` is a separate suite, run against a deployment
rather than the dev server, that checks the Worker, the assets and the API
are wired together: `/api/v1/health` reaches the database through the API,
`/api/openapi.json` and `/api/docs` come from the API, an unknown `/api/*` path
gets the API's JSON 404 rather than the SPA's `index.html` (so
`run_worker_first` works), and `/` and `/design-system` load the app (so the
assets and the SPA fallback work). On a Preview, `sign-in.spec.ts` checks
that `GET /api/v1/auth/login` answers 302 to the Auth0 tenant's
`/authorize`, with the Preview's client ID and callback URL. It reads them
from `api/deploy/auth0.env`. It doesn't sign in. On a Preview,
`offline.spec.ts` installs the service worker (see Service worker), goes
offline, and checks that `/design-system` and `/signed-out` still load and
that `/api/*` doesn't. Its second test loads `/` once online, so the app
saves the session, then loads it offline. Home shows, with the saved
player in the topbar. Then it clears `localStorage` and reloads, and the
error page says "Can’t reach FortyMM". The
main config ignores it; `web-client/playwright.deployed.config.ts` runs it,
with `baseURL` from `PLAYWRIGHT_BASE_URL` (it fails fast without one) and no
screenshot tests. Its `ready` project retries `/api/v1/health` for up to a
minute (Cloud Run cold starts, Preview propagation) before the other specs
run. Against production (`fortymm.com` or `www.fortymm.com`), the config runs
only the `ready` project.
Against a Preview, the `session-limit` project runs last. It makes guest
accounts with a new connection each until the API answers 429, so it checks
the guest account limit through the Worker. It has no retries, because a
retry in the same minute finds the budget spent.
A page load of `/` without a session cookie starts a guest account, and
production keeps every account. So a production run checks only `/api/v1/health`. Against a
Preview, `app.spec.ts` and `offline.spec.ts` answer `POST /api/v1/session`
themselves with `stubSession()` (`e2e/deployed/stubSession.ts`), so their
page loads make no account. It routes on the context, because a page's
route doesn't see the requests of a page that the service worker controls.
The stub isn't in `e2e/fixtures.ts`, because the main suite needs the real
endpoint.
Only `sign-in.spec.ts` and `session-limit.spec.ts` count toward the guest
account limit. `sign-in.spec.ts` starts a login with no session, which
counts as one, so `session-limit` gets 29 before the 429.

```sh
DEPLOY_URL=https://fortymm.com ./bin/mise run web-client:e2e-deployed
```

`web-client:e2e-deployed` starts just the `playwright` container (and `dev`,
whose network it shares), runs the suite there against `DEPLOY_URL`, then
removes the containers. It needs `npm ci` done (as `ci` does). Its traces and
report go to `web-client/test-results/deployed/` and
`web-client/playwright-report/deployed/`, so they don't replace the main
run's, and CI uploads them in the same `playwright-traces` artifact.

