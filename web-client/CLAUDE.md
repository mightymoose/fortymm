# web-client

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

## Tests

In page objects, reach for `screen` (from `@testing-library/react`) by default
rather than `document`. Prefer semantic queries (`screen.queryByText`,
`getByRole`, …) over class selectors. When a check has no semantic anchor (e.g.
an `aria-hidden` element identified only by class), anchor on a `screen` query
and narrow with `.closest()` / `element.querySelector` instead of going through
the global `document`.
