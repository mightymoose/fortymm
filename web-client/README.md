# web-client

The fortymm web client: Vite, React, TypeScript and [TanStack Router](https://tanstack.com/router) with file-based routing. Run everything through `./bin/mise run web-client:<task>` from the repository root, never with `npm` on the host; `CLAUDE.md` lists the tasks.

## Routes

Each screen is a file in `src/routes/`. The file name is the URL (`index.tsx` is `/`; `about.tsx` would be `/about`). See TanStack Router's [file naming conventions](https://tanstack.com/router/latest/docs/framework/react/routing/file-naming-conventions).

- `src/routes/__root.tsx` is the root route: the layout every screen renders inside, and the not-found page shown for any URL that matches no route.
- `src/routes/index.tsx` is the start page at `/`.
- `src/router.ts` creates the router and registers it with the type checker, so a `<Link>` or `navigate()` to a path with no route file fails `web-client:typecheck`.

To add a screen, add a route file that exports `Route = createFileRoute('/path')({ component })`. Nothing else needs registering. The Vite plugin regenerates `src/routeTree.gen.ts` when the dev server (`web-client:up`) starts, whenever a route file changes, and on build.

`src/routeTree.gen.ts` is generated but committed, so the type checker and editors work on a fresh checkout. Don't edit it. If it disagrees with `src/routes/`, `web-client:routes-check` (first step of `web-client:validate`, so in CI) fails, regenerates it, and you commit the result. Generator options go in `tsr.config.json`, which both the Vite plugin and the check read. Lint skips the file.

## Tests

| What | Where | Run by |
| --- | --- | --- |
| A screen's behavior | `src/routes/<route>.test.tsx`, next to the route | `web-client:test` (Vitest, Testing Library, jsdom) |
| Its page object | `src/routes/<route>.page.ts` | used by the test above |
| Type-level claims | `src/**/*.test-d.tsx` | `web-client:typecheck` |
| Wiring that needs the production build as served (today: `/` loads and the bundle runs) | `e2e/`, page objects in `e2e/pages/`; config in `playwright.config.ts` | `web-client:e2e` (Playwright), the last step of `web-client:validate` |
| The web client and another app work together | `../e2e/` | the stack-wide `e2e` task (CI's stage 2) |

A screen test mounts the whole app at a URL with `renderRoute(path)` from `src/test/render-route.tsx`: the real route tree and router configuration, with an in-memory history. Find controls by role and accessible name, inside the page object. The route generator ignores `*.test.*` and `*.page.*` files in `src/routes/` (`tsr.config.json`).

Lint's fast-refresh rule (`react/only-export-components`) is off in `src/routes/`: a route file exports `Route` next to its components by design, and the router plugin handles hot reload for it.
