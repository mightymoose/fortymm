import { useRef } from 'react'

import { cn } from '@/lib/utils'

import { BEST_OF_OPTIONS } from './best-of-options'
import './match-setup.css'

export interface BestOfFieldProps {
  bestOf: number
  setBestOf: (n: number) => void
}

/** Match-length segmented control (Single/Short/Std/Long best-of). */
export const BestOfField = ({ bestOf, setBestOf }: BestOfFieldProps) => {
  // A radiogroup is a single tab stop with roving focus (WAI-ARIA): arrows move
  // between options (and select as they go), Home/End jump to the ends. The
  // buttons handle Space/Enter natively. Refs let an arrow press move focus to
  // the newly-selected option, not just change the value (#64).
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

  function handleKeyDown(event: React.KeyboardEvent, index: number) {
    const last = BEST_OF_OPTIONS.length - 1
    let next: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = index === last ? 0 : index + 1
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = index === 0 ? last : index - 1
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = last
        break
      default:
        return
    }
    event.preventDefault()
    setBestOf(BEST_OF_OPTIONS[next].n)
    optionRefs.current[next]?.focus()
  }

  return (
    <div>
      <div className="nm-field-label">Match length</div>
      <div className="nm-bestof" role="radiogroup" aria-label="Match length">
        {BEST_OF_OPTIONS.map((o, i) => (
          <button
            type="button"
            key={o.n}
            ref={(el) => {
              optionRefs.current[i] = el
            }}
            className={cn('nm-bestof-opt', bestOf === o.n && 'active')}
            role="radio"
            aria-checked={bestOf === o.n}
            // Roving tabindex: only the checked option is in the tab order, so
            // the group is one Tab stop and arrows drive the rest.
            tabIndex={bestOf === o.n ? 0 : -1}
            onClick={() => setBestOf(o.n)}
            onKeyDown={(e) => handleKeyDown(e, i)}
          >
            <span className="big">{o.n}</span>
            <span className="sub">{o.label}</span>
          </button>
        ))}
      </div>
      <div className="nm-help">
        {bestOf === 1
          ? 'One game, winner takes all.'
          : `First to ${Math.ceil(bestOf / 2)} games.`}
      </div>
    </div>
  )
}
