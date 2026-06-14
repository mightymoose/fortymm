import type { SectionHeaderProps } from './section-header'

/** Props for `SectionHeader` — the Events section header. */
export function buildSectionHeaderProps(
  overrides: Partial<SectionHeaderProps> = {},
): SectionHeaderProps {
  return { title: 'Events', subtitle: 'Click any event to edit.', ...overrides }
}
