# web-client

The fortymm web client: Vite, React, TypeScript and [TanStack Router](https://tanstack.com/router) with file-based routing. Run everything through `./bin/mise run web-client:<task>` from the repository root, never with `npm` on the host; `CLAUDE.md` lists the tasks.

## Routes

Each screen is a file in `src/routes/`. The file name is the URL (`index.tsx` is `/`; `about.tsx` would be `/about`). See TanStack Router's [file naming conventions](https://tanstack.com/router/latest/docs/framework/react/routing/file-naming-conventions).

- `src/routes/__root.tsx` is the root route: the layout every screen renders inside, and the not-found page shown for any URL that matches no route.
- `src/routes/index.tsx` is the start page at `/`.
- `src/router.ts` creates the router and registers it with the type checker, so a `<Link>` or `navigate()` to a path with no route file fails `web-client:typecheck`.

To add a screen, add a route file that exports `Route = createFileRoute('/path')({ component })`. Nothing else needs registering. The Vite plugin regenerates `src/routeTree.gen.ts` when the dev server (`web-client:up`) starts, whenever a route file changes, and on build.

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
- **Where the api is.** At `/api` on the app's own origin. Whatever serves the app forwards `/api/*` to the api with `/api` stripped, so `/api/v1/health` reaches the api's `/v1/health`: Vite's `server.proxy` in dev (`vite.config.ts`, to the `api` service), and the hosting, the Worker ("Hosting" below), when it was given an api: a pull request's preview forwards to that pull request's api preview. The production Worker has no api yet and answers `/api` and `/api/*` with a 404. So no route file may produce a URL starting with `/api`.
- **Screens that load data** use a route `loader` that calls the `src/api/` function, and a `pendingComponent` for while it's on the way (see `src/routes/health.tsx`). Turn every answer, including "couldn't reach the api", into data the component shows; don't let the loader throw for an answer the api can give.

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

The icon is `public/favicon.svg`: the design system's logo mark, a flat ball-500 disc (`#FF7A1A`), with "40" in on-accent ink (`#0B0D12`), set in Space Grotesk Bold. The "40" is outlines, not text, since an SVG favicon can't load a web font. `scripts/icon-mark.ts` writes the file: it fetches Space Grotesk Bold from Google Fonts (SIL Open Font License; the font file isn't kept) and reads the two glyphs' outlines itself (`./bin/mise run web-client:exec -- node scripts/icon-mark.ts`). The install icons in `public/icons/` are rendered from `favicon.svg` by `./bin/mise run web-client:icons` (Chromium, `e2e/scripts/render-icons.ts`): 192 and 512 transparent around the disc; a maskable 512 with the disc inside the safe zone on the design system's bg-app (`#0B0D12`); and `apple-touch-icon-180.png` for iPhones, opaque on bg-app. After changing the icon, run the task, look at the PNGs and commit them. The theme colour is ball-500; the background (the splash screen) is the page's white, since the app's pages are not dark yet.

## Hosting

The production build is served by a Cloudflare Worker, at its `workers.dev` address only (no custom domain yet).

| What | Where |
| --- | --- |
| The Worker's configuration: its name (`fortymm`, provisional), the build as its static assets (`../dist`), the compatibility date, `API_ORIGIN` (empty) | `worker/wrangler.jsonc` |
| Every rule the hosting applies, the proxy to the api included | `worker/src/index.ts` |
| The deploy, and its credential check | `worker/scripts/deploy.sh`, `worker/scripts/with-credentials.sh` |
| Which api each Worker is given | `worker/scripts/api-origin.sh`, with the address from `../api/hosting/preview-address.sh` |
| Wrangler, pinned | `worker/package.json` (installed by `web-client:worker-install`, in the `web-client-worker` image) |

**What it serves.** The Worker's code runs first for every request (`run_worker_first`), so every rule is in `src/index.ts`, whatever the platform would otherwise route straight to the files.

- `/api` and `/api/*`: the api's, never a file of the build or the app's page. What happens depends on the api the Worker was given, its `API_ORIGIN` variable (below):
  - Given one: forwarded with `/api` stripped, `/api/v1/health?x=1` to `<API_ORIGIN>/v1/health?x=1` (`/api` to `/`), with the method, the headers (but `Host`, which becomes the api's own) and the body unchanged. The api's answer comes back as it is, status, headers and body, plus `nosniff`; a redirect is handed back, not followed. Only the path and query come from the request: the target is the path set on the api's URL, so no path (`//host/x`, `/@host/x`, `/http://host/x`), header or absolute request target can make the Worker call another host. No CORS is involved: the browser calls the Worker's own origin.
  - Given one it can't reach (refused, no such host): a plain 502 at once. The health page shows it as "unknown", like any answer it doesn't understand.
  - Given none, as the production Worker (there is no production api yet): a plain 404 for every method.
- No other path is forwarded: `/v1/health`, `/apix`, `/API/...` get the app's page like any other path.
- A file of the build: that file, at its own path. `/index.html` is not redirected to `/` (`html_handling: "none"`): the service worker keeps `/index.html` and answers page loads with it, and a browser refuses a redirected response for a page load.
- Any other path, for GET and HEAD: the app's page, and the router decides what it shows (its own not-found page for an unknown path). A missing file under `/assets/`, `/sw.js` or `/manifest.webmanifest` is a 404 instead. Other methods get a 404 (405 for a file).
- `Cache-Control: no-cache` on the app's page (at any path), `/sw.js` and `/manifest.webmanifest`, so a deployment is seen at once and the browser always checks for a new service worker. A Worker's responses never go through Cloudflare's edge cache.
- `public, max-age=31536000, immutable` on files under `/assets/`, whose names carry a hash of their content. Other files (icons) keep the platform's `public, max-age=0, must-revalidate`.
- `X-Content-Type-Options: nosniff` on everything. Content types come from each file's extension (`sw.js` as JavaScript, the manifest as `application/manifest+json`).
- A `_headers` file can't do this: it doesn't apply to responses the Worker makes, and in `dist/` the service worker would try to keep it.

**Which api a Worker is given.** `API_ORIGIN` is empty in `wrangler.jsonc`, so a deploy with that file alone (the production Worker) has none. `web-client:deploy` gives a Worker its api with `wrangler deploy --var API_ORIGIN:<address>`, from the Worker's name (`worker/scripts/api-origin.sh`), and refuses any other name:

| Worker | Its api |
| --- | --- |
| `fortymm` (production) | none: `/api/*` is a 404 |
| `fortymm-pr-<number>` (a pull request's preview) | that pull request's api preview, `fortymm-api-pr-<number>` |
| `fortymm-trial` (a branch tried by hand) | the api's trial, `fortymm-api-trial` |

The address is made from the api preview's name by the api's own `../api/hosting/preview-address.sh`, from `../api/hosting/hosting.env` (`https://<service>-<project number>.<region>.run.app`), the same script `api:preview` checks Cloud Run against, so it is written in one place. That is the second place this app reads a file of another app, after the api types. Api previews are public, so the Worker sends no credential. `web-client:deploy-check` proves each row, and that any other name is refused.

**Locally.** `./bin/mise run web-client:worker-up` builds the app and serves it from the Worker in the local Workers runtime (`wrangler dev`, the same configuration, given no api), and prints the address; `web-client:worker-down` stops it. The cross-app suite (`./bin/mise run e2e`) tests every rule above against four local Workers, given no api, the api's production image, an echo and an api they can't reach ("Tests" below), and `web-client:deploy-check` dry-runs the deployment in `web-client:validate`.

### Deploying

**Each pull request gets a preview of the whole stack.** CI's `preview (api)` job deploys the pull request's api to its own Cloud Run service with its own database (`../api/README.md`, "Previews"). Once it is up, CI's `preview (web-client)` job runs `./bin/mise run web-client:preview -- fortymm-pr-<number>`. That builds the app, uploads it with the Worker (`wrangler deploy`) to a Worker of its own, given that pull request's api preview to forward `/api/*` to, then runs the hosting checks (`web-client:hosting-check`) against its address: the rules every Worker keeps, then the journey across both previews, the health page showing this pull request's api and its database healthy. A preview that breaks a rule fails `ci-passed`. The web client's job waits for the api's, rather than deploying beside it, so its Worker never forwards to an api that isn't there yet or is still on the previous commit, and so the journey is checked by the same command a person runs for a trial. The address is in the job's summary (the run's page, Summary). The checks first wait, up to two minutes, until the address serves this build's `index.html`: a deployment reaches Cloudflare's edge some seconds after `wrangler deploy` returns. Until then a new Worker's address answers Cloudflare's own 404 (`error code: 1042`), and an existing one answers with the previous version. The local Workers runtime has no such delay, so only a deployment shows it. A pull request from a fork or from Dependabot gets no secrets: its preview is skipped, and `ci-passed` doesn't need it. When the pull request closes, merged or not, the `Preview cleanup` workflow deletes its Worker (`web-client:preview-delete`, which refuses any name but `fortymm-pr-<number>`).

**Anyone who can push a branch to this repository and open a pull request from it can deploy a preview with the Cloudflare token**, and so run code of their choosing with it during that job. Pull requests from forks can't: CI runs on `pull_request`, never `pull_request_target`, so a fork's code never gets the secrets.

**A merge to `main` deploys to production.** CI's `deploy (web-client)` job runs on a push to `main` only, after `ci-passed` succeeds: `./bin/mise run web-client:deploy` builds the app and uploads it to the `fortymm` Worker, and runs no checks against it. Nothing is tested against production: the pull request's preview was. Roll back (below) if a deployment must not stay.

It needs two repository secrets (GitHub: Settings, Secrets and variables, Actions, New repository secret). Only the preview, deploy and cleanup jobs read them; without them each fails and says which is missing. The free plan allows 100 Workers per account; previews are deleted when their pull request closes.

- `CLOUDFLARE_ACCOUNT_ID`: the account's ID (Cloudflare dashboard: Workers & Pages, the account ID in the sidebar, or the account's home page).
- `CLOUDFLARE_API_TOKEN`: an API token (dashboard: My Profile, API Tokens, Create Token, Custom token) with one permission, **Account, Workers Scripts, Edit**, and under Account Resources only this account. That is the least that uploads a Worker with its assets and turns on its `workers.dev` address. If a deploy fails for want of another permission, the "Edit Cloudflare Workers" template has everything Wrangler can use, but grants much more (KV, R2, routes on every zone).

The first deploy needs the account to have a `workers.dev` subdomain: opening Workers & Pages in the dashboard once sets one up.

**The address** is `https://fortymm.<account subdomain>.workers.dev`. The deploy job's log prints it, and the dashboard shows it under Workers & Pages, `fortymm`.

**Rolling back.** Dashboard: Workers & Pages, `fortymm`, Deployments, the menu on an earlier version, Rollback. Or, with both credentials in your environment: `./bin/mise run web-client:wrangler -- deployments list`, then `./bin/mise run web-client:wrangler -- rollback <version-id>`. A rollback serves the earlier build at once; phones pick it up like any new version (its `sw.js` differs), at their next opening. The next merge to `main` deploys again over it.

### Trying a branch on Cloudflare before it merges

A pull request's preview does this for you. To deploy the checked-out branch from your own machine instead, to a separate Worker so the one `main` deploys is never touched, first deploy the api's trial (`./bin/mise run api:preview -- fortymm-api-trial`, `../api/README.md`, "Trying a branch by hand"), which the trial Worker forwards `/api/*` to. Then, with your own token (as above) and account ID:

```sh
export CLOUDFLARE_ACCOUNT_ID=<account id>
export CLOUDFLARE_API_TOKEN=<token>
./bin/mise run web-client:preview -- fortymm-trial
```

It deploys to `https://fortymm-trial.<account subdomain>.workers.dev`, then runs the same hosting checks against it (deep path, bundle, `/sw.js`, manifest, caching, the 404s, `nosniff`, opening offline, and the health page through the trial api). To run them again later: `./bin/mise run web-client:hosting-check -- https://fortymm-trial.<account subdomain>.workers.dev`. Against a Worker given no api, such as the production one, add `--no-api`: it checks the `/api/*` 404s instead of the health journey. They check the address serves the build in `web-client/dist`, so run them from the checkout that deployed it, with that build in place. To remove the trial Worker: `./bin/mise run web-client:wrangler -- delete fortymm-trial`, or the dashboard: Workers & Pages, `fortymm-trial`, Settings, Delete.

## Tests

| What | Where | Run by |
| --- | --- | --- |
| A screen's behavior | `src/routes/<route>.test.tsx`, next to the route | `web-client:test` (Vitest, Testing Library, jsdom) |
| Its page object | `src/routes/<route>.page.ts` | used by the test above |
| Type-level claims (the router's paths; the client's requests, the zod schemas' input and the mocks typed from the document) | `src/**/*.test-d.ts(x)` | `web-client:typecheck` |
| The build step that writes the service worker (`offline/plugin.ts`: every emitted file is kept) | `offline/*.test.ts` | `web-client:test` |
| What only a real browser shows about the production build by itself: opening with no connection, a new deployment reaching the device, installability | `e2e/tests/*.spec.ts`, page objects in `e2e/pages/` | `web-client:e2e` (Playwright, the last step of `web-client:validate`) |
| How the build is hosted, by the Worker ("Hosting" above), whatever api it was given: what a person sees (a deep path gets the app; the bundle runs as served; the app opens offline after one visit) in `../e2e/tests/hosting.spec.ts`, and its HTTP rules (headers, 404s) in `../e2e/tests/hosting-rules.spec.ts` | `../e2e/`, Playwright project `worker` | the stack-wide `e2e` task (CI's stage 2), against the local Workers runtime; `web-client:hosting-check`, against any address |
| A Worker given no api: `/api` and `/api/*` a plain 404 for every method; `/health` says the api's health is unknown | `../e2e/tests/hosting-no-api.spec.ts`, project `worker-no-api` | the `e2e` task; `web-client:hosting-check --no-api` |
| The journey: the health page, through the Worker, shows the api and its database healthy | `../e2e/tests/health.spec.ts`, project `api-journey` | the `e2e` task, given the api's production image; `web-client:preview` (CI's `preview (web-client)`), given the pull request's api preview |
| A Worker given the real api: the api's own status and document come back (200, 405, 404); an api answer is never kept on the device | `../e2e/tests/hosting-api.spec.ts`, project `worker-api` | the `e2e` task |
| The proxy, byte for byte, against `api-echo`, a stand-in that answers with what it received (`../dev/api-echo/`): method, path, query, headers and body arrive unchanged; status and redirects come back unchanged; `/api/<a file of the build>` goes to the api; no other path is forwarded; no path, header or absolute target reaches another host | `../e2e/tests/hosting-proxy.spec.ts`, project `worker-proxy` | the `e2e` task |
| A Worker given an api it can't reach: a plain 502 at once; `/health` says unknown | `../e2e/tests/hosting-unreachable.spec.ts`, project `worker-unreachable` | the `e2e` task |
| Which api each Worker is given (`worker/scripts/api-origin.sh`) | `worker/` | `web-client:deploy-check` |
| The Worker typechecks; its deployment's dry runs; the deploy's credential check; the preview delete's and `web-client:preview`'s refusals | `worker/` | `web-client:deploy-check` (last step of `web-client:validate`) |

The browser suite (`e2e/`) drives the production build served by `vite preview` (`web-client-preview`), from the `web-client-e2e` service, which shares its network, so the app is at `http://localhost:4173`: a secure context, where service workers run. `web-client:e2e` copies the build to `e2e/.builds/current`, makes `e2e/.builds/next` from it (the page's title says "(next deployment)", and `sw.js` is rewritten by the same build step), and serves `e2e/.site`, which a test replaces with `deploy('current' | 'next')` (`e2e/pages/deployment.ts`) to publish a new deployment. Those directories are gitignored. The tests run one at a time, since the server is shared. A test opens the app by loading an address directly in a new page (`App.open(path)`), the way a tab or the home-screen icon does, and goes offline with `context.setOffline(true)`.

The cross-app suite drives the Worker in the local Workers runtime four times, each given a different api with `wrangler dev --var API_ORIGIN:<address>` (`../compose.dev.yaml`): `web-client-worker` none, `web-client-worker-api` the api's production image (`api-release`, with `api-db`), `web-client-worker-echo` the echo (`api-echo`), `web-client-worker-unreachable` a port nothing listens on. Each Playwright project gets one address (`../e2e/playwright.config.ts`). The echo is there because the real api has no route that would show a query or a body arriving; everything the api itself answers is tested through `web-client-worker-api`.

A screen's page object has two kinds of method:

- `render()` mounts the whole app at the screen's URL, through `renderRoute(path)` in `src/test/render-route.tsx`: the real route tree and router configuration, with an in-memory history. (`NotFoundPage.render(path)` takes any URL with no route, defaulting to `/no/such/page`.)
- The rest only find elements, by role and accessible name (`heading()`, `counter()`).

The test does the interactions itself, with user-event, so they read in its body:

```tsx
const user = userEvent.setup()
const start = new StartPage()
await start.render()
await user.click(await start.counter())
expect(await start.counter()).toHaveAccessibleName('Count is 1')
```

### A screen that calls the api

[MSW](https://mswjs.io/) stands in for the api, at the network level, so the client and everything above it run for real. `src/test/setup.ts` starts the server (`src/test/api/server.ts`) once per file, resets its handlers after each test, and fails any test that sent a request no handler answered. There are no default handlers: each test says how the api answers, before `render()`:

```tsx
server.use(databaseUnavailable())
const page = new HealthPage()
await page.render()
expect(await page.databaseUnavailable()).toBeVisible()
```

Handlers live in `src/test/api/<resource>.ts`, one function per way the api can answer. Write them with the `http` from `src/test/api/server.ts` ([openapi-msw](https://github.com/christoph-fricke/openapi-msw)) and `response(status).json(body)`. Path, status and body are then checked against the document, so a mock can't return what the api doesn't send. It matches the URL the browser really requests (`/api/v1/health`), while you write the api's own path (`/v1/health`). For an answer the document doesn't declare on purpose (a network error, an HTML page from a misrouted host), use `response.untyped(...)`.

`renderRoute()` doesn't wait for the route's loader, so a test can see the pending state. Every finder is a `findBy*`, which waits.

Don't add action methods (`clickCounter()`) to a page object. The route generator ignores `*.test.*` and `*.page.*` files in `src/routes/` (`tsr.config.json`).

Lint's fast-refresh rule (`react/only-export-components`) is off in `src/routes/`: a route file exports `Route` next to its components by design, and the router plugin handles hot reload for it.
