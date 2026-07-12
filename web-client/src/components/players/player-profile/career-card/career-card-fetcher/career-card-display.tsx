import { useId } from 'react'

import { cn } from '@/lib/utils'

import { CareerTile } from './career-card-display/career-tile'
import { WinRateRing } from './career-card-display/win-rate-ring'
import { type CareerView } from './career-card-query'

export interface CareerCardDisplayProps {
  career: CareerView
}

/**
 * The profile's **Career** card: a player's lifetime record across *every*
 * league they play in (`CONTEXT.md` § *Career*; ADR-0915) — the win-rate ring,
 * the W–L, the current streak, and the best-streak and games-won tiles.
 *
 * Two things it is careful never to do:
 *
 * - **Reconcile its total with the Recent-matches card's.** This card counts
 *   `career.decided`; the card beside it links to `match_total`, the
 *   all-inclusive history. 47 decided and 50 in the history is a player with 3
 *   matches in play, not an inconsistency — so the total is *labelled*
 *   "47 decided · 2 leagues" rather than left as a naked number a reader would
 *   try to square with "View all 50 matches".
 * - **Follow the league.** Career is cross-league: nothing here is keyed on the
 *   profile's league, so the league switcher cannot move a number on this card.
 *
 * Pure view-in, DOM-out: every figure arrives pre-formatted from the projection.
 */
export const CareerCardDisplay = ({ career }: CareerCardDisplayProps) => {
  const id = useId()

  return (
    <section className="player-profile__section career-card" aria-labelledby={id}>
      <div className="player-profile__section-header">
        <h2 className="player-profile__section-title" id={id}>
          Career
        </h2>
        {/* "47 decided · 2 leagues" — the word carries the whole distinction. */}
        <span className="player-profile__section-count career-card__total">
          {career.total}
        </span>
      </div>

      <div className="career-card__body">
        {/* Ring and record read together — they are the same fact twice, once as
            a shape and once as a pair of numbers. The tiles are a separate,
            lesser register and sit under both, spanning the card. */}
        <div className="career-card__headline">
          <WinRateRing ring={career.ring} />

          <div className="career-card__figures">
            <p className="career-card__record">{career.record}</p>

            {career.streak ? (
              <span
                className={cn(
                  'career-card__streak',
                  `career-card__streak--${career.streak.tone}`,
                )}
              >
                {career.streak.label}
              </span>
            ) : (
              <span className="career-card__streak career-card__streak--none">
                No current streak
              </span>
            )}
          </div>
        </div>

        <div className="career-card__tiles">
          {career.tiles.map((tile) => (
            <CareerTile key={tile.label} tile={tile} />
          ))}
        </div>
      </div>
    </section>
  )
}
