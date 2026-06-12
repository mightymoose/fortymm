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

## Forms

Show field validation errors inline, directly below the field, in red. Set
`aria-invalid` on the `<Input>` and render the message as a `<p>` beneath it:

```tsx
<Input aria-invalid defaultValue="not-an-email" />
<p className="mt-1.5 text-xs text-[color:var(--loss)]">
  Enter a valid email address.
</p>
```

Do not use toasts, alerts, or other patterns for field-level validation errors.
