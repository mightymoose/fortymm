import type { CareerRingView } from '../career-card-query'

export interface WinRateRingProps {
  ring: CareerRingView
}

const RADIUS = 42
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * The Career card's win-rate ring: an arc swept in proportion to the share of
 * decided matches the player has won, with the percentage in the middle.
 *
 * The share drives only the *geometry*; the figure in the middle is the
 * pre-formatted `label` from the projection — so this component cannot turn
 * `0.375` into "0.375%" or "0%" by accident. A player who has decided nothing
 * has no share at all: the arc is simply absent (not a zero-length one drawn
 * over a "0%"), and the middle reads `—`.
 *
 * The ring is one `role="img"` with an accessible name, since the text inside it
 * is decoration a reader shouldn't have to reassemble.
 */
export const WinRateRing = ({ ring }: WinRateRingProps) => {
  const swept = ring.share == null ? 0 : CIRCUMFERENCE * ring.share

  return (
    <div className="career-card__ring" role="img" aria-label={ring.ariaLabel}>
      <svg className="career-card__ring-svg" viewBox="0 0 96 96" aria-hidden="true">
        <circle className="career-card__ring-track" cx="48" cy="48" r={RADIUS} />
        {ring.share != null && (
          <circle
            className="career-card__ring-arc"
            cx="48"
            cy="48"
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE - swept}
            // Start the sweep at twelve o'clock rather than three.
            transform="rotate(-90 48 48)"
          />
        )}
      </svg>
      <span className="career-card__ring-figure" aria-hidden="true">
        {ring.label}
      </span>
      <span className="career-card__ring-caption" aria-hidden="true">
        Win rate
      </span>
    </div>
  )
}
