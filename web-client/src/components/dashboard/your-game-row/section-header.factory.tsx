import type { SectionHeaderProps } from './section-header'

/** Props for `SectionHeader` — just a title, so the default render is
 * harness-free (no subtitle, no action link to route). */
export function buildSectionHeaderProps(
  overrides: Partial<SectionHeaderProps> = {},
): SectionHeaderProps {
  return { title: 'Your game', ...overrides }
}
