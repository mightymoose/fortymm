import type { CareerRingView } from '../career-card-query'
import type { WinRateRingProps } from './win-rate-ring'

/** A player who wins 68.6% of their decided matches. */
export function buildWinRateRingView(
  overrides: Partial<CareerRingView> = {},
): CareerRingView {
  return {
    share: 24 / 35,
    label: '68.6%',
    ariaLabel: 'Win rate 68.6%',
    ...overrides,
  }
}

/**
 * A player who has decided nothing: no share, so no arc and an em dash where the
 * figure goes. Emphatically **not** a 0% — that would say they lose every match
 * they play.
 */
export function buildEmptyWinRateRingView(
  overrides: Partial<CareerRingView> = {},
): CareerRingView {
  return buildWinRateRingView({
    share: null,
    label: '—',
    ariaLabel: 'Win rate unavailable: no decided matches yet',
    ...overrides,
  })
}

export function buildWinRateRingProps(
  overrides: Partial<WinRateRingProps> = {},
): WinRateRingProps {
  return { ring: buildWinRateRingView(), ...overrides }
}
