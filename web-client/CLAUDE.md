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

We **parse untrusted data at every boundary with Zod** (the repo-wide rule and its
rationale live in `.claude/rules/parse-at-boundaries.md`). The tool per surface:

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
