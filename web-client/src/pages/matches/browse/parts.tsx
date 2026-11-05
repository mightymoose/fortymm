import { useNavigate } from '@tanstack/react-router'
import { useRef } from 'react'
import { Icon } from '../../../components/Icon'
import { type MatchRecord, type Side, yourSide } from './sampleMatches'
import { VARIANTS, type Variant } from './variants'

// The match's one status signal, as the design system's match row draws it.
export function MatchStatus({ match }: { match: MatchRecord }) {
  const { status } = match
  switch (status.kind) {
    case 'live':
      return <span className="live-marker">Live</span>
    case 'disputed':
      return (
        <span className="fm-status fm-status--conflict">
          <Icon name="alert" />
          Scores disagree
        </span>
      )
    case 'awaiting': {
      const waitingOn = match.players[status.signedBy === 0 ? 1 : 0]
      return (
        <span className="fm-status">
          <Icon name="clock" />
          {waitingOn.you ? 'Waiting for you' : `Waiting for ${waitingOn.name}`}
        </span>
      )
    }
    case 'final':
      return <span className="fm-status">Final</span>
  }
}

// The viewer's rating change from a final rated match, signed with its arrow.
export function RatingChange({ match, side }: { match: MatchRecord; side?: Side }) {
  if (match.status.kind !== 'final' || match.status.rating === null) return null
  const which = side ?? yourSide(match)
  if (which === null) return null
  const delta = match.status.rating[which]
  return delta >= 0 ? (
    <span className="rating-up">▲ +{delta}</span>
  ) : (
    <span className="rating-down">▼ −{Math.abs(delta)}</span>
  )
}

// The prototype's own controls: which option shows, and that the matches are
// samples. Not part of any option.
export function PrototypeBar({ variant, labels }: { variant: Variant; labels: Record<Variant, string> }) {
  const navigate = useNavigate()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const pick = (next: Variant) =>
    void navigate({ to: '.', search: (prev: object) => ({ ...prev, variant: next }), replace: true })
  return (
    <div className="match-proto">
      <div className="fm-seg" role="radiogroup" aria-label="Prototype option">
        {VARIANTS.map((option, index) => (
          <button
            key={option}
            ref={(button) => {
              buttons.current[index] = button
            }}
            type="button"
            role="radio"
            aria-checked={option === variant}
            tabIndex={option === variant ? 0 : -1}
            onClick={() => pick(option)}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
              if (!step) return
              event.preventDefault()
              const next = (index + step + VARIANTS.length) % VARIANTS.length
              pick(VARIANTS[next])
              buttons.current[next]?.focus()
            }}
          >
            {option.toUpperCase()} · {labels[option]}
          </button>
        ))}
      </div>
      <p className="fm-notice">
        <Icon name="info" />
        <span>Prototype with sample matches. The API doesn’t list matches yet, and nothing here is sent.</span>
      </p>
    </div>
  )
}
