import type { PageTitleProps } from './page-title'

/**
 * Props for `PageTitle` — the full-width desktop greeting for a signed-in user.
 * The "Log a match" action always renders a typed `<Link>`, so the page object
 * mounts it under a memory router.
 */
export function buildPageTitleProps(
  overrides: Partial<PageTitleProps> = {},
): PageTitleProps {
  return { greeting: 'Hi, rita.kovac', compact: false, ...overrides }
}
