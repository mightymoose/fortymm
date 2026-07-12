import type { NotFoundContentProps } from './not-found-content'

/**
 * The generic "unknown URL" 404: a headline, one sentence, the requested path
 * echoed in the meta line, and a single recovery action.
 *
 * The action defaults to a plain `<a>` rather than a TanStack `<Link>` so a
 * bare `notFoundContentPage.render()` needs no router harness. Pass a real
 * `<Link>` (and mount a router) when a test cares about typed navigation.
 */
export function buildNotFoundContentProps(
  overrides: Partial<NotFoundContentProps> = {},
): NotFoundContentProps {
  return {
    headline: 'Page not found.',
    body: 'That URL doesn’t lead anywhere we know about.',
    meta: { label: 'Requested path', value: '/this-page-does-not-exist' },
    action: <a href="/dashboard">Back to dashboard</a>,
    ...overrides,
  }
}
