import { render, screen, type Container } from '@/test/utilities'

import { CareerTile, type CareerTileProps } from './career-tile'
import { buildCareerTileProps } from './career-tile.factory'

const scoped = (container: Container) => ({
  /** A tile's value, found by its label the way a reader finds it ("Best
   * streak", "Games won"). `null` when the card renders no such tile. */
  queryCareerTile(label: string): HTMLElement | null {
    const key = container.queryByText(label, {
      selector: '.career-card__tile-k',
    })
    const value = key
      ?.closest('.career-card__tile')
      ?.querySelector('.career-card__tile-v')
    return (value as HTMLElement | undefined) ?? null
  },
})

/** Test page-object for `CareerTile` — a label/value pair, queried by its label
 * exactly as the Career card's own page object queries it. */
export const careerTilePage = {
  render(overrides: Partial<CareerTileProps> = {}) {
    render(<CareerTile {...buildCareerTileProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
