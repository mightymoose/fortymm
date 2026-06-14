import { render, screen, type Container } from '@/test/utilities'

import { MatchSection, type MatchSectionProps } from './match-section'
import { buildMatchSectionProps } from './match-section.factory'

const scoped = (container: Container) => ({
  getRatedSwitch() {
    return container.getByRole('switch', { name: 'Rated' })
  },
  getLengthOption(label: string) {
    return container.getByRole('radio', { name: label })
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
