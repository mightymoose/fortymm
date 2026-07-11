import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, within, type Container } from '@/test/utilities'

import { READ_ONLY_VALUE_TESTID } from '../../read-only-value.page'
import { MatchSection, type MatchSectionProps } from './match-section'
import { buildMatchSectionProps } from './match-section.factory'

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
      READ_ONLY_VALUE_TESTID,
    )
  },
  /** The best-of length as a viewer sees it. */
  getLengthValue() {
    return within(container.getByTestId('match-length-card')).getByTestId(
      READ_ONLY_VALUE_TESTID,
    )
  },
  /** Every interactive control in the section, swept by role. Supplement only —
   * `getFormElements()` is the guarantee. */
  getInteractiveControls() {
    return interactiveControlsIn(container)
  },
  /** Every interactive element in the section, swept by DOM (`@/test/read-only`).
   * Empty is the point of the read-only view. */
  getFormElements() {
    return interactiveElementsIn(container.getByTestId('match-section'))
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
