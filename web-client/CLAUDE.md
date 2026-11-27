# web-client

Vite + React + TypeScript. Runs only in Docker (see the root `CLAUDE.md`); never run `node` or `npm` on the host.

- Dev server: use the `web-client-dev` skill, or `./bin/mise run web-client:dev`.
- npm: `./bin/mise run web-client:npm -- <args>` (e.g. `install <pkg>`, `run build`, `run lint`).
- Source is in `src/`; the entry point is `src/main.tsx`.
- Unit tests: Vitest + Testing Library (jsdom). Tests sit next to the code under test as `*.test.tsx`, with a page object for each screen in `*.page.tsx` (`src/App.page.tsx` renders the whole app at a given path). Import `it` from `src/setupTests.ts` to get a `user` (userEvent) fixture. Test links by clicking through the whole app. `./bin/mise run web-client:test` runs them in the container.
- E2E tests: Playwright, in `e2e/`. `./bin/mise run web-client:e2e` runs them in the container (Chromium is baked into the image; Playwright starts its own Vite server there). The HTML report goes to `playwright-report/`.
