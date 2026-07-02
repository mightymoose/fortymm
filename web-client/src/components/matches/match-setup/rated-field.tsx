import { Link } from '@tanstack/react-router'

import { cn } from '@/lib/utils'

import type { Opponent } from './opponent'
import './match-setup.css'

export interface RatedFieldProps {
  rated: boolean
  setRated: (rated: boolean) => void
  opponent: Opponent | null
  isGuest: boolean
}

/** Rated-match toggle — disabled with an explainer until an opponent is
 * picked, and nudges a guest toward adding an email once it's on. */
export const RatedField = ({
  rated,
  setRated,
  opponent,
  isGuest,
}: RatedFieldProps) => {
  const ratable = opponent !== null
  const effectiveRated = rated && ratable

  let description: string
  if (effectiveRated) {
    description = 'Result will update both ratings.'
  } else if (ratable) {
    description = 'No rating change. Still logged to history.'
  } else {
    description = 'Pick an opponent to make this rated.'
  }

  return (
    <div>
      <div className="nm-field-label">
        Rated match
        {!ratable && <span className="na">No opponent · unavailable</span>}
      </div>
      <div className="nm-rated">
        <button
          type="button"
          className={cn('nm-switch', effectiveRated && 'on')}
          role="switch"
          aria-checked={effectiveRated}
          aria-label="Rated match"
          aria-describedby={
            effectiveRated && isGuest ? 'nm-rated-guest-hint' : undefined
          }
          disabled={!ratable}
          onClick={() => ratable && setRated(!rated)}
        />
        <div className="nm-rated-info">
          <div className="t">
            {effectiveRated ? 'Counts toward rating' : 'Just for fun'}
          </div>
          <div className="d">{description}</div>
        </div>
      </div>
      {effectiveRated && isGuest && (
        <p id="nm-rated-guest-hint" className="nm-rated-guest-hint">
          Your rating sticks around once you{' '}
          <Link to="/settings" hash="sec-email" className="nm-rated-guest-link">
            add an email
          </Link>
          .
        </p>
      )}
    </div>
  )
}
