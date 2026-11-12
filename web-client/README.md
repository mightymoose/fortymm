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
- **Where the api is.** At `/api` on the app's own origin. Whatever serves the app forwards `/api/*` to the api with `/api` stripped, so `/api/v1/health` reaches the api's `/v1/health`: Vite's `server.proxy` in dev (`vite.config.ts`, to the `api` service), `web-client-hosting`'s nginx in the cross-app suite, and the production hosting when it lands. So no route file may produce a URL starting with `/api`.
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
- **The hosting** must serve `/sw.js` at the root, as JavaScript, with `Cache-Control: no-cache` and never from an edge cache, and never answer it with `index.html`. `dev/web-client-hosting/default.conf` does, and says why.

## Installing

`public/manifest.webmanifest` (linked from `index.html`) names the app `fortymm` and opens it in its own window (`display: standalone`) at `/`. Browsers offer to install it, and on an iPhone it can be added to the home screen with Share, then "Add to Home Screen". There it opens as its own app, and Safari no longer clears its storage after a week without use.

The icon is `public/favicon.svg`, an orange ball (`#f58900`) with a dark "40" (`#2d241b`). The install icons in `public/icons/` are rendered from it by `./bin/mise run web-client:icons` (Chromium, `e2e/scripts/render-icons.ts`): 192 and 512 transparent, a maskable 512 with the ball inside the safe zone on white, and `apple-touch-icon-180.png`, opaque on white, for iPhones. The "40" is text in Arial; the render image has no Arial and draws it in Liberation Sans Bold, which has the same letter widths. After changing the icon, run the task, look at the PNGs and commit them. The theme colour is the ball's orange; the background (the splash screen) is the page's white.

## Tests

| What | Where | Run by |
| --- | --- | --- |
| A screen's behavior | `src/routes/<route>.test.tsx`, next to the route | `web-client:test` (Vitest, Testing Library, jsdom) |
| Its page object | `src/routes/<route>.page.ts` | used by the test above |
| Type-level claims (the router's paths; the client's requests, the zod schemas' input and the mocks typed from the document) | `src/**/*.test-d.ts(x)` | `web-client:typecheck` |
| The build step that writes the service worker (`offline/plugin.ts`: every emitted file is kept) | `offline/*.test.ts` | `web-client:test` |
| What only a real browser shows about the production build by itself: opening with no connection, a new deployment reaching the device, installability | `e2e/tests/*.spec.ts`, page objects in `e2e/pages/` | `web-client:e2e` (Playwright, the last step of `web-client:validate`) |
| How the build is hosted (a deep path gets the app; the bundle loads and mounts as served; `sw.js` served uncached), and wiring to another app (the hosted page reaches the api, and an api answer is never kept: `../e2e/tests/health.spec.ts`). It asserts what a person sees, not status codes or headers, except that one header | `../e2e/` | the stack-wide `e2e` task (CI's stage 2) |

The browser suite (`e2e/`) drives the production build served by `vite preview` (`web-client-preview`), from the `web-client-e2e` service, which shares its network, so the app is at `http://localhost:4173`: a secure context, where service workers run. `web-client:e2e` copies the build to `e2e/.builds/current`, makes `e2e/.builds/next` from it (the page's title says "(next deployment)", and `sw.js` is rewritten by the same build step), and serves `e2e/.site`, which a test replaces with `deploy('current' | 'next')` (`e2e/pages/deployment.ts`) to publish a new deployment. Those directories are gitignored. The tests run one at a time, since the server is shared. A test opens the app by loading an address directly in a new page (`App.open(path)`), the way a tab or the home-screen icon does, and goes offline with `context.setOffline(true)`.

The hosting the cross-app suite drives today is `web-client-hosting`, an nginx stand-in (`dev/web-client-hosting/`) for the production hosting, Cloudflare Workers, which is not in this repository yet. When it lands, point the suite at it (for example the Workers runtime run locally) and remove the stand-in.

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
