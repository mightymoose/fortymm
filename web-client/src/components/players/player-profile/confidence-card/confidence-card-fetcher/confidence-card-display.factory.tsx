import type { ConfidenceCardDisplayProps } from './confidence-card-display'
import type { ConfidenceView } from './confidence-card-query'

/**
 * A **settled** rating: RD 69.4 around a rating of 1687, which puts the 95%
 * interval at 1551–1823 — the numbers the card's copy is written against.
 *
 * There is no confidence *percentage* in here, and there must never be one: it
 * is not a number that exists (`CONTEXT.md` § *Rating confidence*).
 */
export function buildConfidenceView(
  overrides: Partial<ConfidenceView> = {},
): ConfidenceView {
  return {
    level: 'settled',
    levelLabel: 'Settled',
    interval: { low: '1551', high: '1823' },
    details: [
      { label: 'Deviation (RD)', value: '69.4' },
      { label: 'Volatility (σ)', value: '0.0592' },
    ],
    ...overrides,
  }
}

/** A brand-new player: the system has no idea where they belong, and the interval
 * is honestly enormous. */
export function buildProvisionalConfidenceView(
  overrides: Partial<ConfidenceView> = {},
): ConfidenceView {
  return buildConfidenceView({
    level: 'provisional',
    levelLabel: 'Provisional',
    interval: { low: '1088', high: '1912' },
    details: [
      { label: 'Deviation (RD)', value: '210' },
      { label: 'Volatility (σ)', value: '0.0600' },
    ],
    ...overrides,
  })
}

/** The middle level. */
export function buildFirmingUpConfidenceView(
  overrides: Partial<ConfidenceView> = {},
): ConfidenceView {
  return buildConfidenceView({
    level: 'firming_up',
    levelLabel: 'Firming up',
    interval: { low: '1452', high: '1922' },
    details: [
      { label: 'Deviation (RD)', value: '120' },
      { label: 'Volatility (σ)', value: '0.0605' },
    ],
    ...overrides,
  })
}

/**
 * Props for `ConfidenceCardDisplay`. `isViewer` defaults to **false** — the
 * common case is looking at somebody else, and third person is the voice that is
 * safe to be wrong in (ADR-0915).
 */
export function buildConfidenceCardDisplayProps(
  overrides: Partial<ConfidenceCardDisplayProps> = {},
): ConfidenceCardDisplayProps {
  return { confidence: buildConfidenceView(), isViewer: false, ...overrides }
}
