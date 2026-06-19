import type { ButtonProps } from './button'

/** Props for `Button` — the "Log a match" CTA, its most common usage.
 *
 * Note: the default sets `to`, so the rendered element is a TanStack Router
 * `<Link>` (not a `<button>`). That means the page object must mount under a
 * memory router — mirror how `attention-panel.page.tsx` does it. */
export function buildButtonProps(
  overrides: Partial<ButtonProps> = {},
): ButtonProps {
  return { children: 'Log a match', to: '/matches/new', ...overrides }
}
