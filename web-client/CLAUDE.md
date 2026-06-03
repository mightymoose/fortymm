# web-client

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
