import { render, screen, type Container } from '@/test/utilities'

import { HeroStat, type HeroStatProps } from './hero-stat'
import { buildHeroStatProps } from './hero-stat.factory'

const scoped = (container: Container) => ({
  getByLabel(label: string) {
    return container.getByText(label)
  },
})

/** Test page-object for `HeroStat`. */
export const heroStatPage = {
  render(overrides: Partial<HeroStatProps> = {}) {
    render(<HeroStat {...buildHeroStatProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
