import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { ChampionBanner, type ChampionBannerProps } from './champion-banner'
import { buildChampionBannerProps } from './champion-banner.factory'

const scoped = (container: Container) => ({
  /** The callout by its panel-supplied test id — `query…` because a panel only mounts it
   * once the event is decided. */
  queryBanner(testId: string) {
    return container.queryByTestId(testId)
  },

  /** Everything interactive in the banner — must be empty. It is a fact about a finished
   * event, not a control. */
  getControls(testId: string) {
    return interactiveElementsIn(container.getByTestId(testId))
  },
})

/** Test page-object for `ChampionBanner`. */
export const championBannerPage = {
  render(overrides: Partial<ChampionBannerProps> = {}) {
    render(<ChampionBanner {...buildChampionBannerProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
