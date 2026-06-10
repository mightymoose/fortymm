---
name: react-component
description: Build or extract React components in web-client/ the fortymm way — one component per file with a colocated page object, factory, and vitest test, composed page-object query surfaces, query-selector view models, and MSW endpoint mocks. Use this skill whenever you create a new component, extract markup out of an existing page/component, add tests for a component, or touch anything under web-client/src/components — even if the request only says "add a widget", "split this up", or "test this".
---

# Building web-client React components

Every component in `web-client/src` ships as a colocated quartet in its feature
directory. The canonical exemplars live in
`web-client/src/components/matches/match-details/scoreboard/` — when in doubt,
open `game-grid-cell.{tsx,page.tsx,factory.tsx,test.tsx}` (leaf component) and
`game-grid.{tsx,page.tsx,factory.tsx,test.tsx}` (composes the row, which
composes the cell) and copy their shapes.

```
feature-dir/
├── thing.tsx           # the component — props in, DOM out
├── thing.page.tsx      # test page object — the only place tests touch the DOM
├── thing.factory.tsx   # builders for the component's props/view types
└── thing.test.tsx      # tests, written entirely against the page object
```

File names are kebab-case; components are PascalCase named exports (no default
exports). One component per file — if a component grows a distinct sub-block
(a row, a chip, a cell), extract it into its own quartet and compose.

## The component (`thing.tsx`)

- Export the props interface alongside the component:
  `export interface ThingProps { ... }` + `export const Thing = ({ ... }: ThingProps) => ...`.
- Props are **pre-projected view models**, not raw API payloads. The component
  receives a `View` type produced by a query selector (see "Data-fed
  components" below) and does no joining, mapping, or label derivation —
  conditionals only on fields the view already provides. Keep nullability
  decisions at the owner: if a child is absent when its view is null, the
  *parent* does the null check and the child always receives a non-null view
  (see how `Heading` guards `chip` rather than `StatusChip` accepting null).
- Prefer semantic, role-queryable markup (a `<section aria-labelledby>` with an
  `sr-only` heading, `role="status"`, real links) so page objects can query by
  role and accessible name. A `data-testid` is a last resort for elements no
  role/name can distinguish — and never add markup (wrappers, testids, props
  like a `rowSide` discriminator) that exists *only* to serve tests; scope
  queries with `within(row)` instead. (The GameGrid exemplars predate this
  rule — their `scoreboard-game-grid-*` testids are slated for removal in
  #475; don't copy that part.) When you do need one, namespace and
  parameterize it: `feature-thing-${variant}`.
- Conditional classes via `cn(...)` from `@/lib/utils`.
- Prefer design-system components in `src/components/ui` over bespoke markup
  (see `web-client/CLAUDE.md`).

## The page object (`thing.page.tsx`)

The page object is the component's *test query surface*. Tests never call
`screen.getBy...` directly — every accessor lives here, once, and parent page
objects reuse it. The shape is always:

```tsx
import { render, screen, type Container } from "@/test/utilities";
import { Thing, type ThingProps } from "./thing";
import { buildThingProps } from "./thing.factory";
import { childPage } from "./child.page";

const scoped = (container: Container) => ({
  /** JSDoc every accessor: what it is, and when it's absent. */
  getThing() {
    return container.getByTestId("feature-thing");
  },
  queryThing() {
    return container.queryByTestId("feature-thing");
  },
  // Reuse the child's queries instead of re-deriving them — either spread
  // (same surface) or named (a sub-object):
  ...childPage.within(container),        // when the child's queries read naturally as this component's
  child: childPage.within(container),    // when a named grouping is clearer
});

/** Test page-object for `Thing` — one sentence on what it covers, plus any
 * harness quirks (router, suspense) and how tests should start. */
export const thingPage = {
  render(overrides: Partial<ThingProps> = {}) {
    const props = buildThingProps(overrides);
    render(<Thing {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed this component spread
   * this to expose the same queries as their own, rather than re-deriving.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
```

Rules that make this composition work:

- **`scoped` + `within` + spread-at-`screen`** is the load-bearing trio. Every
  accessor closes over `container`, never `screen` directly. `Container` comes
  from `@/test/utilities`.
- Always `render` through `@/test/utilities` (it wraps in a fresh, retry-free
  `QueryClient`), never raw `@testing-library/react`.
- Provide `get`/`query`/`find` variants as tests need them: `get` for
  must-exist, `query` for asserting absence, `find` when the first paint is
  async.
- **Typed `<Link>`s need a router harness.** If the component (or any
  descendant) renders a TanStack `<Link>`, `render` must mount it under a
  minimal memory router that registers a stub route for each link target —
  copy the harness in `game-grid-cell.page.tsx`. The router resolves
  asynchronously, so document that tests must start with `await page.find...()`
  and write them that way. If sibling page objects need the same harness,
  extract it into a shared helper rather than pasting it a third time (#475
  tracks doing this for the game-grid trio).
- Accessors take discriminating parameters (`gameNumber`, a row's player name)
  and resolve them the same way the component distinguishes the elements —
  by role/name within a scope where possible, by parameterized testid
  otherwise.

## The factory (`thing.factory.tsx`)

Builders for the props and any view types the component consumes:

```tsx
/** One-line doc of the default scenario this builds. */
export function buildThingView(
  overrides: Partial<ThingView> = {},
): ThingView {
  return { /* realistic, internally consistent defaults */ ...overrides };
}

/** Props for `Thing`. */
export function buildThingProps(
  overrides: Partial<ThingProps> = {},
): ThingProps {
  return { thing: buildThingView(), ...overrides };
}
```

- Defaults describe one **realistic, named scenario** (e.g. "a live BO5 one
  game in, viewer's row first") — say which in the doc comment, and keep the
  defaults internally consistent so a bare `page.render()` is a meaningful
  case.
- Factories compose child factories (`buildGameGridView` calls
  `buildGameGridRowView`), and union view types get one builder per variant
  (`buildScoredCellView` / `buildUnplayedCellView`), typed with
  `Partial<Extract<View, { kind: "..." }>>`.
- Pick defaults that avoid harness requirements where possible — e.g. the
  scored-cell default carries no edit link so it renders without a router —
  and note the exception in the doc comment.
- The `.factory.tsx` / `.page.tsx` suffixes matter: Stryker excludes them from
  mutation (`stryker.config.mjs` `mutate` globs). Don't invent new suffixes.

## The test (`thing.test.tsx`)

```tsx
import { buildThingView } from "./thing.factory";
import { thingPage } from "./thing.page";

describe("Thing", () => {
  it("states the behavior, not the implementation", async () => {
    thingPage.render({ thing: buildThingView({ ... }) });

    const el = await thingPage.findThing();   // find-first when a router/suspense is in play
    expect(el).toHaveTextContent("...");
  });
});
```

- Vitest globals (`describe`/`it`/`expect`/`vi`) — no imports for them.
- Tests touch the DOM **only** through the page object; the only other imports
  are factories, `msw`'s `HttpResponse`, and occasional `@/test/utilities`
  helpers (`within`, `waitForElementToBeRemoved`).
- One behavior per test; names read as behavior sentences ("links an editable
  scored cell to that game's scores/edit route").
- **Test content at the layer that owns it.** A parent asserts it *wired* the
  child in (the child's container is present/absent, rendered against the
  right id), not the child's internals — leave a breadcrumb comment like
  `// Wiring only: grid content is pinned by the query and game-grid tests.`
  Conversely the leaf tests pin every branch of the leaf.
- The suite is mutation-tested (`npm run test:mutation:changed`). Assert
  specific values and class/attribute effects (`toHaveClass`,
  `toHaveAttribute("href", ...)`, exact text), not just `toBeInTheDocument`,
  so mutants die.

## Data-fed components: the query → fetcher → display split

When a component renders server data, split it into layers, each its own
quartet (exemplar: `scoreboard-query.ts` → `scoreboard-fetcher.tsx` →
`scoreboard-display.tsx`):

1. **Query selector (`thing-query.ts` + `thing-query.test.ts`)** — exports the
   `View` types and a query-options factory built on the page's BFF query
   (e.g. `matchDetailsQuery`) with a `select` that projects the payload into
   the view. All mapping, label text, ordering, and perspective logic lives
   here, tested as pure functions in a plain `.test.ts` (no DOM). Document
   each view field's semantics and null conditions on the type.
2. **Fetcher (`thing-fetcher.tsx`)** — a thin `useSuspenseQuery(thingQuery(id))`
   that hands the view to the display. Its page object supplies the
   `<Suspense>` + `ErrorBoundary` harness and stubs the endpoint (see
   `scoreboard-fetcher.page.tsx`); its tests cover pending → resolved handoff
   and that a failed query reaches the boundary.
3. **Display (`thing-display.tsx`)** — pure view-in, DOM-out, tested without
   MSW.

MSW pieces live under `src/mocks` and are typed off the generated API schema:

- **Endpoint helper** (`src/mocks/endpoints/<area>/<name>.endpoint.ts`):
  exports `mockThingEndpoint(backend, resolver)` and a typed `ThingResolver`,
  so tests write `HttpResponse.json(buildThing(...))` with payload
  type-checking. Page objects wrap it as `page.mockEndpoint(resolver)`.
- **Payload factories** (`src/mocks/factories/<area>/<name>.factory.ts`):
  `build*` functions over `components["schemas"][...]` from `@/api/schema` —
  same overrides pattern as component factories, but producing wire payloads.

Remember the vitest MSW server runs with `onUnhandledRequest: "error"`: any
fetch a test triggers needs a handler (the page object's `mockEndpoint` or
`src/mocks/handlers.ts`).

## Definition of done

From `web-client/`: `npm run lint`, `npm run build` (type-checks), and
`npm run test:run` all pass. For meaningful new logic, sanity-check assertion
strength with `npm run test:mutation:changed`.
