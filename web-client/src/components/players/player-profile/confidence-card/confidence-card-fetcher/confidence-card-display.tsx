import { useId } from 'react'

import { cn } from '@/lib/utils'

import type {
  ConfidenceLevel,
  ConfidenceView,
} from './confidence-card-query'

export interface ConfidenceCardDisplayProps {
  confidence: ConfidenceView
  /** True when the person looking at this profile *is* the player it is about.
   * The only thing it changes is the pronoun (ADR-0915) — none of the numbers. */
  isViewer: boolean
}

/**
 * The card's copy, in both voices (ADR-0915: "The player profile is
 * viewer-aware").
 *
 * Second person on your own profile, third person on everybody else's: "A
 * reliable read on where **you** stand" is right on your own profile and a lie on
 * a stranger's. Which of the two it is arrives as a prop, decided off the
 * *payload* by the projection (`ConfidenceView.isOwn`) — never off the session,
 * which would not have answered yet by the time this paints.
 *
 * The two voices are written out in full rather than assembled from a pronoun
 * variable, because they don't differ only by pronoun — "where you *stand*"
 * (settled) versus "where you *belong*" (provisional) is a real distinction, and
 * a template would quietly flatten it.
 */
const EXPLANATIONS: Record<ConfidenceLevel, { second: string; third: string }> = {
  settled: {
    second: 'A reliable read on where you stand. The math is quiet.',
    third: 'A reliable read on where they stand. The math is quiet.',
  },
  firming_up: {
    second: 'We’re closing in on where you stand. The swings are getting smaller.',
    third: 'We’re closing in on where they stand. The swings are getting smaller.',
  },
  provisional: {
    second: 'We’re still working out where you belong. Expect big swings.',
    third: 'We’re still working out where they belong. Expect big swings.',
  },
}

/** The lead-in to the interval — the honest, concrete version of the claim, and
 * the reason the card is worth trusting. Viewer-aware for the same reason the
 * explanation is. */
const INTERVAL_LEAD = {
  second: 'We think you’re somewhere between',
  third: 'We think they’re somewhere between',
}

/**
 * The profile's **Rating confidence** card: how settled a player's rating is, and
 * what range they might really be in (`CONTEXT.md` § *Rating confidence*).
 *
 * Three things it does, and one it very deliberately does not:
 *
 * - **Names the level in words** — Provisional / Firming up / Settled — beside a
 *   status dot, because that is the summary a reader actually wants.
 * - **Puts the 95% interval on its face**: "We think they're somewhere between
 *   1551 and 1823." This is the rigorous statement confidence *is*, and the whole
 *   reason the card can be trusted; it is not drawer material.
 * - **Hides the machinery.** Deviation (RD) and volatility (σ) are the Glicko-2
 *   internals *behind* confidence, not names for it, so they sit in a collapsed
 *   drawer for the curious.
 * - **Shows no percentage.** There is no such number. An "86%" would be an
 *   arbitrary rescaling of RD onto a 0–100 axis, saying nothing the level and the
 *   interval don't say better. No bar, no percent, no 0–100 anything — an earlier
 *   design had one and it was cut on purpose.
 *
 * Pure view-in, DOM-out: every figure arrives pre-formatted from the projection,
 * and the only branch here is the voice.
 */
export const ConfidenceCardDisplay = ({
  confidence,
  isViewer,
}: ConfidenceCardDisplayProps) => {
  const id = useId()
  const voice = isViewer ? 'second' : 'third'

  return (
    <section
      className="player-profile__section confidence-card"
      aria-labelledby={id}
    >
      <div className="player-profile__section-header">
        <h2 className="player-profile__section-title" id={id}>
          Rating confidence
        </h2>
      </div>

      <div className="confidence-card__body">
        <p className="confidence-card__level">
          <span
            className={cn(
              'confidence-card__dot',
              `confidence-card__dot--${confidence.level}`,
            )}
            aria-hidden="true"
          />
          {confidence.levelLabel}
        </p>

        <p className="confidence-card__explanation">
          {EXPLANATIONS[confidence.level][voice]}
        </p>

        {/* The interval, on the face. */}
        <p className="confidence-card__interval">
          {INTERVAL_LEAD[voice]}{' '}
          <strong className="confidence-card__bound">
            {confidence.interval.low}
          </strong>{' '}
          and{' '}
          <strong className="confidence-card__bound">
            {confidence.interval.high}
          </strong>
          .
        </p>

        {/* …and the machinery, collapsed. Closed by default: nobody opening a
            profile is asking after a rating deviation. */}
        <details className="confidence-card__drawer">
          <summary className="confidence-card__drawer-summary">
            The numbers behind it
          </summary>
          <dl className="confidence-card__details">
            {confidence.details.map((detail) => (
              <div className="confidence-card__detail" key={detail.label}>
                <dt className="confidence-card__detail-label">{detail.label}</dt>
                <dd className="confidence-card__detail-value">{detail.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </section>
  )
}
