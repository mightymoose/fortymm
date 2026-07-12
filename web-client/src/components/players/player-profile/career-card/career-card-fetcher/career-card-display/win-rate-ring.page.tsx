import { render, screen, type Container } from '@/test/utilities'

import { WinRateRing, type WinRateRingProps } from './win-rate-ring'
import { buildWinRateRingProps } from './win-rate-ring.factory'

const scoped = (container: Container) => ({
  /** The ring as a whole — one `role="img"`, named by its accessible label
   * ("Win rate 68.6%"). */
  getRing() {
    return container.getByRole('img', { name: /win rate/i })
  },
  /** The figure printed in the middle of the ring: "68.6%", or `—` for a player
   * who has decided nothing. */
  getRingFigure() {
    return container.getByText(
      (_: string, el: Element | null) =>
        el?.classList.contains('career-card__ring-figure') ?? false,
    )
  },
  /** The swept arc. `null` when there is no share to sweep — a player who has
   * decided nothing gets no arc at all, not a zero-length one. */
  queryRingArc(): SVGCircleElement | null {
    return document.querySelector('.career-card__ring-arc')
  },
})

/**
 * Test page-object for `WinRateRing`. The arc is an SVG with no role of its own,
 * so it is reached by class; everything a *reader* gets — the accessible name and
 * the figure — is reached the way they get it.
 */
export const winRateRingPage = {
  render(overrides: Partial<WinRateRingProps> = {}) {
    render(<WinRateRing {...buildWinRateRingProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
