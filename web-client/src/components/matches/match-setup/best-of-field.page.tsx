import { render, screen, type Container } from '@/test/utilities'

import { BestOfField, type BestOfFieldProps } from './best-of-field'
import { buildBestOfFieldProps } from './best-of-field.factory'

const scoped = (container: Container) => ({
  /** The match-length radiogroup. */
  getGroup() {
    return container.getByRole('radiogroup', { name: 'Match length' })
  },
  /** One best-of option by its displayed number (1/3/5/7). */
  getOption(n: number) {
    return container.getByRole('radio', { name: new RegExp(`^${n}`) })
  },
  /** The help line under the control. */
  getHelp(text: string | RegExp) {
    return container.getByText(text)
  },
})

/** Test page-object for `BestOfField` — the match-length segmented radiogroup. */
export const bestOfFieldPage = {
  render(overrides: Partial<BestOfFieldProps> = {}) {
    render(<BestOfField {...buildBestOfFieldProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
