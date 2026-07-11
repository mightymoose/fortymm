# web-client

## Architecture

**Routing is file-based and generated.** `src/routes/*.tsx` files are compiled
into `routeTree.gen.ts` by the `@tanstack/router-plugin/vite` plugin. Don't
edit `routeTree.gen.ts` by hand.

**MSW only intercepts in `import.meta.env.DEV`.** See `src/main.tsx` (and the
`VITE_ENABLE_MSW=false` escape hatch for hitting a real API). The vitest setup
(`src/test/setup.ts`) uses the Node MSW server with
`onUnhandledRequest: 'error'` — every fetch in a test must have a matching
handler in `src/mocks/handlers.ts` (or one added via `server.use(...)`).
Production builds never load MSW.

**`VITE_API_URL`** overrides the API base URL; otherwise the client uses
`window.location.origin`. In dev that means MSW handles everything; in the
compose stack the web origin is also where nginx proxies the API.

## Testing

Two layers, mocked two different ways — don't confuse them:

- **vitest** (`npm run test:run`, jsdom) mocks the network with **MSW**
  (`onUnhandledRequest: 'error'`). This is the fast inner loop.
- **`web-client/e2e/`** (`npm run test:e2e`, Playwright) runs with **MSW OFF**
  and stubs the network via inline Playwright `page.route` interceptors. vitest
  will NOT catch a mismatch here: when a BFF endpoint or the API schema changes,
  you must update the affected `page.route` stubs and run the e2e suite, or it
  goes green in vitest and breaks in e2e. (The **root `e2e/`** suite is a
  separate, full-stack thing — not this one.)
- **Screenshot baselines** are committed for both darwin and chromium-linux
  (e.g. `*-chromium-linux.png`). Regenerate the linux baselines with the
  `mcr.microsoft.com/playwright` docker image so CI (linux) doesn't churn.

Reach for the `react-component` skill (component + page-object + factory + vitest
quartet) and the `fetching-data` skill (TanStack Query `queryOptions` factories)
for the file-layout conventions — they're not otherwise written down here.

## Conventions

- Path alias: `@/*` → `src/*` (see `vite.config.ts`, `components.json`).
- shadcn components go under `src/components/ui` (configured in
  `components.json`).
- **Render usernames bare — no leading `@`.** Display a username as
  `{username}`, never `@{username}`. This holds everywhere: the dashboard
  greeting, the login confirmation/success screens, the merge gate, the user
  menu, match details, and the topbar pill. (#289)

## Design system

Prefer the shared design-system components in `src/components/ui` (showcased on
the `/design-system` route) whenever one fits the need, instead of hand-rolling a
bespoke inline-styled element. Before building a panel, banner, button, badge,
etc., check `/design-system` for an existing component and use it — match the
semantics, not just the look (e.g. a content panel is a `Card`; a dismissible
"the app talking back" status/notice is an `Alert`, not a `Card`). Apply accent
treatments via the same className/token patterns the showcase uses (e.g. the
`--ball-500`/`--warn`/`--serve-500` tints, `var(--shadow-glow)` for the
"Featured" highlight) rather than reinventing borders and gradients. Reach for a
custom element only when nothing in the design system is a reasonable fit.

## Boundaries

We **parse untrusted data at every boundary with Zod.** The tool per surface:

- **Forms** → React Hook Form + `zodResolver`. See `## Forms` below.
- **URL search + path params** → a Zod schema. Prefer a route
  `validateSearch: (s) => schema.parse(s)` over the raw
  `(search: Record<string, unknown>) => ({ ... })` spread for new routes, so a malformed
  URL fails at the route boundary instead of leaking `undefined`s into the page.
- **Network responses** → Zod-parse the decoded payload at the fetch boundary before it
  flows into the app. The generated `schema.d.ts` (see the root `CLAUDE.md` OpenAPI
  invariant) gives the compile-time shape; Zod gives the runtime guarantee — they're
  complementary, not redundant.
- **`localStorage` / `sessionStorage` / any other external input** → read the value as
  `unknown` and `.parse()` it through a Zod schema; treat a parse failure as absent.

## Forms

**Every form that submits a mutation uses React Hook Form + Zod.** Drive the
form with `useForm({ resolver: zodResolver(schema) })` and validate
client-side against a Zod schema that **mirrors the server's constraints**
(e.g. `z.string().trim().min(1).max(255)` for a column that is `VARCHAR(255)`
and `NOT NULL`) — so the user gets an inline message instead of a bare 4xx.
`EditRoleModal` (`src/components/rbac/roles-page.tsx`) and
`NewTournamentModal` are the reference implementations.

- **Surface server 4xx inline, don't swallow it.** Submit with
  `handleSubmit(async (v) => { try { await mutateAsync(...) } catch (e) { ... } })`,
  and in the catch map an `ApiError` with status 422/409 to
  `form.setError('<field>', { type: 'server', message: e.detail ?? '…' })`;
  toast anything else. A modal must close itself **only on success** — never
  unconditionally after firing the mutation, or a rejected request becomes a
  silent failure (#614).
- **Don't attach a global `onError` toast to a mutation a form surfaces
  inline.** The form owns its errors; a global toast would double up. (See the
  convention note on the RBAC form mutations in `rbac/queries.ts`.)
- **Don't gate the submit button on `formState.isValid`.** `handleSubmit`
  already blocks an invalid submit and renders the inline error; a
  `disabled={!isValid}` button forces a `useEffect(trigger)` workaround for
  edit forms (defaults that start valid) and leaves the user staring at a dead
  button with no explanation. Disable on `isSubmitting` only.

Show field validation errors inline, directly below the field, in red. Set
`aria-invalid` on the `<Input>` and render the message as a `<p>` beneath it:

```tsx
<Input aria-invalid defaultValue="not-an-email" />
<p className="mt-1.5 text-xs text-[color:var(--loss)]">
  Enter a valid email address.
</p>
```

Do not use toasts, alerts, or other patterns for field-level validation errors.

## Read-only surfaces

When a surface is editable by some users and merely viewable by others (today:
the tournament surfaces, gated by the server-computed `canEdit` flag on the
tournament payload), **render a view — do not disable the form.** The reasoning
is in [ADR 0015](../docs/adr/0015-read-only-is-a-view-not-a-disabled-form.md);
the tooling is:

- **`ReadOnlyValue`** (`src/components/tournaments/read-only-value.tsx`) is the
  read-only counterpart to `Field`'s control slot — it renders the value as text
  with the same row rhythm, and an em-dash (`—`) when the value is unset. Branch
  at the control: `{canEdit ? <Input … /> : <ReadOnlyValue>{draft.name}</ReadOnlyValue>}`.
  A read-only surface must put **no** `<input>` / `<select>` / `<textarea>` /
  `<switch>` in the accessibility tree.
- **Hide mutating affordances — never disable them.** Save, Delete, Revert, and
  the add/remove row buttons are wrapped in `{canEdit && …}`, not given a
  `disabled` prop. A disabled button is an unexplained dead end.
- **Drop the form's furniture too, at `Field`.** Pass `readOnly` to `Field` and it
  suppresses the **hint** and the **required asterisk**. A hint explains how to
  fill in a control and an asterisk marks one you must complete — both are
  nonsense next to a value nobody can edit. Suppressing them *in `Field`* rather
  than at each call site means a newly-added field can't reintroduce them by
  forgetting to.
- **Swap organizer-voiced copy.** Imperatives written for the person in control
  ("Edit event", "Click any event to edit") get neutral copy when `!canEdit`.
- **Every read-only-capable component carries a guard test** asserting that with
  `canEdit: false` it renders zero interactive controls. **Sweep the DOM, not just
  ARIA roles** — a role-only sweep silently under-proves:

  | Control | Role you'd guess | Role it actually has |
  | --- | --- | --- |
  | `<Input type="number">` | `textbox` | **`spinbutton`** |
  | `<Input type="date">` / `type="time"` | `textbox` | **none at all** |
  | `ToggleGroupItem` | `button` | **`radio`** |

  The toggle case is the nastiest, because an **explicit `role` overrides the
  implicit one**: `ToggleGroupItem` renders `<button role="radio">`, so
  `queryAllByRole('button')` never matches it. A whole live toggle group sails
  through a role sweep — measured, not theorised: with the status ToggleGroup left
  live in the read-only branch, the four-role sweep found **0** controls and
  passed, while the DOM sweep found **5**.

  So a sweep of `textbox`/`combobox`/`switch`/`button` can pass with live date,
  number, and toggle inputs still on screen — a false green of exactly the kind
  this rule exists to prevent. Assert on the DOM instead, scoped to the
  component's root (and make sure that root actually wraps every field):

  ```tsx
  it('renders no interactive controls for a non-owner', () => {
    render(<BasicsSection event={anEvent()} canEdit={false} onChange={vi.fn()} />)
    expect(
      page.root().querySelectorAll(
        'input, select, textarea, button, [role="switch"], [role="radio"], [tabindex], [contenteditable]',
      ),
    ).toHaveLength(0)
  })
  ```

  This is what keeps the rule true as fields are added — it fails loudly the
  moment someone reaches for `disabled` out of habit. A role sweep may be kept
  *alongside* it, but never instead of it.

Hiding a control is a UX decision, **never** a security boundary: the API
independently 403s every owner-only endpoint, and must continue to.
