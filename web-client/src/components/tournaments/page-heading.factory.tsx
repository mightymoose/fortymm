import type { PageHeadingProps } from './page-heading'

/** Props for `PageHeading` — the tournaments list header. */
export function buildPageHeadingProps(
  overrides: Partial<PageHeadingProps> = {},
): PageHeadingProps {
  return {
    breadcrumb: [{ label: 'Manage' }, { label: 'Tournaments' }],
    title: 'Tournaments',
    ...overrides,
  }
}
