import { render, screen, within, type Container } from '@/test/utilities'

import { MatchSection, type MatchSectionProps } from './match-section'
import { buildMatchSectionProps } from './match-section.factory'

/** The roles a form control would take in the accessibility tree. A read-only
 * surface must render none of them (ADR 0015). */
const INTERACTIVE_ROLES = ['textbox', 'combobox', 'switch', 'button'] as const

/** The role sweep alone under-proves this section: the length picker's toggle
 * items are `radio`s, which the four canonical roles don't cover. This catches
 * the element itself, whatever role it claims — the full selector documented in
 * `web-client/CLAUDE.md`, verbatim, so a focusable `[tabindex]` div cannot walk
 * through a sweep that was trimmed to only the controls this section has today. */
const FORM_ELEMENTS =
  'input, select, textarea, button, [role="switch"], [role="radio"], [tabindex], [contenteditable]'

const scoped = (container: Container) => ({
  getRatedSwitch() {
    return container.getByRole('switch', { name: 'Rated' })
  },
  getLengthOption(label: string) {
    return container.getByRole('radio', { name: label })
  },
  /** The rated card's description. Rendered in both modes, but its copy differs:
   * the organizer is told how to change it, the viewer only what it means. */
  getRatedDescription() {
    return container.getByTestId('match-rated-description')
  },
  /** The rated state as a viewer sees it — prose, not a dead toggle. */
  getRatedValue() {
    return within(container.getByTestId('match-rated-card')).getByTestId(
      'tournament-read-only-value',
    )
  },
  /** The best-of length as a viewer sees it. */
  getLengthValue() {
    return within(container.getByTestId('match-length-card')).getByTestId(
      'tournament-read-only-value',
    )
  },
  /** Every interactive control in the section. Empty is the point of the
   * read-only view. */
  getInteractiveControls() {
    return INTERACTIVE_ROLES.flatMap((role) => container.queryAllByRole(role))
  },
  /** Every form element in the section, by tag/widget role rather than by the
   * four canonical roles — the escape hatch the role sweep misses. */
  getFormElements() {
    return container
      .getByTestId('match-section')
      .querySelectorAll(FORM_ELEMENTS)
  },
})

/** Test page-object for `MatchSection`. */
export const matchSectionPage = {
  render(overrides: Partial<MatchSectionProps> = {}) {
    render(<MatchSection {...buildMatchSectionProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
