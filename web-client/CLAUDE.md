# web-client

`web-client/` is a Vite + React + TypeScript app, tested with Vitest and React
Testing Library. Each task builds the dev image if needed, installs Node
(pinned in `mise.container.toml`) and the app's npm dependencies inside the
container, then runs.

```sh
./bin/mise run web-client:test   # run the unit tests once
./bin/mise run web-client:dev    # start the Vite dev server on a free host port

This file holds the web-client's conventions. What each part does is in
`docs/`. Read the part's doc before you change it:

- `docs/web-client-pages.md`: the shell, the account menu, sign-in errors,
  "Is this you?", new match, admin and the public pages.
- `docs/web-client-scoring.md`: the scoring pages, the URL fragment, board
  sync and the result pages.
- `docs/web-client-data.md`: the API client and the saved session, the
  signing key, error pages and the service worker.
- `docs/web-client-testing.md`: the unit test helpers and mocks, the
  Playwright suites and the post-deploy suite.


## Routing

Routes use TanStack Router's file-based routing. Each file in
`web-client/src/routes/` defines one route, and its path in that directory
gives the URL (see TanStack Router's file naming conventions). The
`@tanstack/router-plugin` Vite plugin (in `vite.config.ts`, before the React
plugin) reads the directory and writes the route tree to
`web-client/src/routeTree.gen.ts`. `createAppRouter()` in `src/router.tsx`
builds the router from that tree. Its `defaultPreload: 'intent'` makes every
`Link` load its route's chunk and run its loaders when the pointer rests on it
or it takes focus. `defaultPreloadStaleTime: 0` leaves the caching to TanStack
Query, so the click runs the loaders again. A loader must stay safe to run
early: it reads, and starts nothing the visitor didn't ask for. A redirect a
preload throws is dropped. A preload never starts the session. With none
cached, `_authenticated`'s `beforeLoad` throws `notFound()`, which the router
drops quietly. So a hover on `/signed-out`'s Play as a guest makes no guest
account. The click still loads the route.

The plugin writes the tree when Vite starts: the dev server (which also
watches the directory), `vite build` and Vitest. Commit
`routeTree.gen.ts` with the route change. `tsc -b` reads it before Vite runs
in `npm run build`. If it is stale, CI fails (see `web-client:routes-check`).
oxlint skips it. The web-client has no formatter.

`autoCodeSplitting` puts each route's component in its own JS chunk. The
router loads a route's chunk before it shows the route. A route file holds
only the route definition. The components it shows live outside
`src/routes/`, because the plugin treats every file there as a route:
`src/pages/` holds the page and layout components and their tests. Import the
component in the route file and don't export it from there, or it stays in
the entry chunk.

To add a page, add its component to `src/pages/` and a route file that shows
it to `src/routes/`.


## Data

- `api` (`src/api/client.ts`) is an openapi-fetch client typed by the
  generated schema, with base URL `/api`. openapi-fetch sends no
  `Content-Type` for a request with no body, and the API answers 415 to
  such a `POST`, so a bodyless `POST` or `DELETE` sends `JSON_HEADERS`.
- `src/api/queries.ts` holds the query options, one function per request,
  each going through `send()`. It throws `ApiUnreachable` when no response
  came back and `ApiError` when the response isn't ok.
- A component that loads data reads it with `useSuspenseQuery` inside its
  own `QueryBoundary`, with a skeleton in the shape of the content.
  [../.claude/rules/loading-and-errors.md](../.claude/rules/loading-and-errors.md)
  says why. The session is the one exception.
- The app must work offline in a hall with no signal. Nothing about
  scoring or approving a result may wait on the network.

## Tests

- Unit tests live next to the code as `*.test.tsx` and go through page
  objects in `src/test/pages/`, which find elements by accessible role.
  Assertions stay in the tests.
- MSW mocks the API (`src/test/server.ts`), and an unhandled request fails
  the test. Type each mock body with the schema's type, such as
  `components['schemas']['SessionResponse']`.
- A test of anything that reloads or leaves the page mocks
  `src/leavePage.ts` with `vi.mock('../leavePage')`.
- Playwright specs in `e2e/` import `test` and `expect` from
  `e2e/fixtures.ts`. Screenshot baselines only match when taken in the
  `playwright` container (`docker compose exec playwright npx playwright
  test --update-snapshots`, with the stack and dev server up). Then run the
  suite again without the flag.
- Keep the `playwright` image tag in `compose.yaml` in sync with
  `@playwright/test` in `package.json`.

## Design

The app follows the FortyMM design system (v2.1) in
`../references/design-system/`. Read these files before you design or style
UI:
- [README.md](../references/design-system/README.md): the principles,
  colour, type, component roles, containers, states, spacing, motion, voice
  and the v1 features that v2 removed.
- [SKILL.md](../references/design-system/SKILL.md): a one-screen quick
  reference to the README.
- [colors_and_type.css](../references/design-system/colors_and_type.css):
  the tokens and type roles. `src/styles/tokens.css` and
  `src/styles/base.css` copy them.
- [ui_kits/components/](../references/design-system/ui_kits/components/):
  the component library. `index.html` is the gallery that `/design-system`
  copies, and `states.html` shows every control in each state.
- [ui_kits/tournament/](../references/design-system/ui_kits/tournament/):
  organizer desktop and player mobile screens built from the components.
  Copy screen patterns from here.

Don't copy from `ui_kits/ios`, `android`, `web_admin`, `marketing` or
`spectator`. They are legacy v2.

Use the `fm-*` classes and the CSS variables. Don't use raw colours, raw
spacing or page-specific styles. Styles below says which
files are copies that you must not edit.

## Styles

The design system's styles apply to the whole app; `main.tsx` imports them:

- `src/styles/tokens.css`: the `:root` tokens (CSS variables) of
  `references/design-system/colors_and_type.css`, plus the self-hosted fonts
  in `src/assets/fonts/`.
- `src/styles/base.css`: the base, type roles, status markers and motion of
  the same file. Then the app's own styles: the loading screen,
  `.app-shell` (`src/pages/AppShell.tsx`), which below 900px also moves the
  toast region above its tab bar (#150), `.roadmap`, the list of what's
  ready and what's coming that Home shows (`src/pages/Home.tsx`), and
  `.sign-in-error` (`SignInErrorAlert`).
- `src/styles/kit.css`: the component classes (`fm-*`) of
  `references/design-system/ui_kits/components/kit.css`.
- `src/styles/page.css`: the gallery's page chrome (`.doc-*`), with `.page`
  (the page's wrapper in `AppShell` and in `src/pages/DesignSystem.tsx`) for
  its `.doc`.

The reference's parts of these files are copies. Don't edit them.
`e2e/reference-styles.spec.ts` fails when a copy differs from the reference.
If the reference changes, copy the change in.

`public/favicon.svg` is the reference's `assets/logo-mark.svg` without its
C2PA manifest. The same spec fails if the two differ.

Each font is split into woff2 files by `unicode-range`, so a page downloads
only the files its text uses. `space-grotesk.css` comes from Fontsource.
`web-client/scripts/subset-fonts.py` writes `bebas-neue.css`,
`jetbrains-mono.css` and their files from the reference's TTFs, the same
files the reference kit embeds. If the reference's fonts change, run it again
(`docker compose run --rm dev /app/bin/docker-entrypoint uv run --no-project
web-client/scripts/subset-fonts.py`).

`index.html` preloads the latin file of each font, because every first paint
uses them. Without the preloads, the browser
finds the fonts only after `main.tsx` renders, so the page and the loading
screen show fallback text first. Vite rewrites the preload `href`s to the
same hashed files the CSS uses. If you rename or add a font that the first
paint uses, update the preloads too.

Use these classes and CSS variables rather than raw values or page-specific
styles. `/design-system` is where the app's styles are checked against the
reference (see the screenshot tests in `docs/web-client-testing.md`).


## Dev server

Vite listens on port 5173 inside the container, and Docker publishes it on a
free host port. `web-client:dev`:

- prints the URL first (`web-client dev server: http://localhost:<port>`).
  Vite's own banner below it shows the in-container port 5173, which is not
  the one to open.
- then streams the server's logs. Ctrl-C stops and removes the container.

`./bin/mise run list-ports` shows the port again later.

## Dependencies

`node_modules` lives in a Docker volume, not on the host, so native packages
match the container's platform. Install or run npm commands through the
container, e.g.
`docker compose run --rm -w /app/web-client dev npm install <pkg>`.

