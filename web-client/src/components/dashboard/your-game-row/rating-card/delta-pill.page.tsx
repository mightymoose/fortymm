import { render, screen, type Container } from '@/test/utilities'

import { DeltaPill, type DeltaPillProps } from './delta-pill'
import { buildDeltaPillProps } from './delta-pill.factory'

/** Whatever the chip says, however it is signed: "+24 last match",
 * "-12 last match", "+0 last match". The one handle for "is there a chip at
 * all?" — its absence is the established-rating contract (#952). */
const DELTA_PILL_TEXT = /last match/

const scoped = (container: Container) => ({
  /** The chip span, resolved by its text (a `Pill` is a bare span with no role). */
  getDeltaPill(text: string | RegExp = DELTA_PILL_TEXT) {
    return container.getByText(text)
  },
  /** `null` when no chip is rendered — i.e. when the rating was *established*
   * by the last rated match rather than moved by it. */
  queryDeltaPill(text: string | RegExp = DELTA_PILL_TEXT) {
    return container.queryByText(text)
  },
})

/**
 * Test page-object for `DeltaPill` — the "+24 last match" chip on the rating
 * card. Owners (the rating card) spread `within` to expose these as their own,
 * so "the chip is gone" is asserted through the same accessor everywhere.
 */
export const deltaPillPage = {
  render(overrides: Partial<DeltaPillProps> = {}) {
    render(<DeltaPill {...buildDeltaPillProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
