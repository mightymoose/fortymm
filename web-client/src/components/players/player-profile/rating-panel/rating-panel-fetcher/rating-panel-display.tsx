import { useId } from 'react'

import { cn } from '@/lib/utils'

import { FormChips } from './rating-panel-display/form-chips'
import { type RatingPanelView } from './rating-panel-query'

export interface RatingPanelDisplayProps {
  standing: RatingPanelView
}

/**
 * Where the player stands: the big rating, the Δ from their most recent rated
 * match, their rank out of the ladder, their peak, and their last ten results.
 *
 * Pure view-in, DOM-out — it derives nothing. A `null` in the view is the whole
 * conditional: no rating reads "Unrated"; a null delta renders no chip at all
 * (never a "+0"); an unrated player simply has no stats to list.
 */
export const RatingPanelDisplay = ({ standing }: RatingPanelDisplayProps) => {
  const id = useId()

  return (
    <section className="player-profile__standing" aria-labelledby={id}>
      <h2 className="player-profile__overline" id={id}>
        FortyMM Rating
      </h2>

      <div className="player-profile__rating-row">
        <div
          className={cn(
            'player-profile__hero-rating-chip',
            standing.rating === null &&
              'player-profile__hero-rating-chip--unrated',
          )}
        >
          {standing.rating ?? 'Unrated'}
        </div>
        {standing.delta && (
          <span
            className={cn(
              'player-profile__delta',
              standing.delta.tone === 'win'
                ? 'player-profile__delta--win'
                : 'player-profile__delta--loss',
            )}
            aria-label={standing.delta.ariaLabel}
          >
            {standing.delta.label}
          </span>
        )}
      </div>

      {standing.stats.length > 0 && (
        <dl className="player-profile__stats">
          {standing.stats.map((stat) => (
            <div className="player-profile__stat" key={stat.label}>
              <dt className="player-profile__stat-k">{stat.label}</dt>
              <dd className="player-profile__stat-v">{stat.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {standing.form && <FormChips form={standing.form} />}
    </section>
  )
}
