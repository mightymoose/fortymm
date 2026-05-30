import { User } from 'lucide-react'
import { cva } from 'class-variance-authority'

import { initialsOf } from '@/lib/initials-of'

export const NO_OPPONENT_LABEL = 'No opponent'

// Shared "avatar + name" identity, used by both the hero header (size: 'hero')
// and the compact line-score row (size: 'line'). A single `state` — derived
// from the side's win / no-opponent status — drives the winner, loser, and
// no-opponent treatments so the two surfaces stay in sync. An empty username
// is treated as the "no opponent" placeholder.
type Size = 'hero' | 'line'
type State = 'win' | 'loss' | 'ghost'

const avatarVariants = cva('md-avatar', {
  variants: {
    size: {
      hero: 'md-hero__avatar-singles',
      line: '',
    },
    state: {
      win: 'md-avatar--win',
      loss: 'md-avatar--loss',
      ghost: 'md-avatar--ghost',
    },
  },
})

const nameVariants = cva('', {
  variants: {
    size: {
      hero: 'md-hero__name',
      line: 'md-games__player-name min-w-0 truncate',
    },
    // The winner/ghost colour classes are size-specific, so they're applied as
    // compound variants below rather than on `state` alone.
    state: { win: '', loss: '', ghost: '' },
  },
  // The winner colour is driven by the `data-won` attribute (see the name
  // elements below), so only the no-opponent (ghost) treatment lives here.
  compoundVariants: [
    { size: 'hero', state: 'ghost', class: 'md-hero__name--ghost' },
    { size: 'line', state: 'ghost', class: 'md-games__player-name--ghost' },
  ],
})

interface ParticipantProps {
  // Empty string renders the "no opponent" placeholder.
  username: string
  won?: boolean
  size: Size
  // Hero only: which side, for the mirrored left/right alignment.
  align?: 'l' | 'r'
}

export function Participant({
  username,
  won = false,
  size,
  align = 'l',
}: ParticipantProps) {
  const isGhost = username === ''
  const state: State = isGhost ? 'ghost' : won ? 'win' : 'loss'

  const avatar = (
    <span
      className={avatarVariants({ size, state })}
      aria-hidden={isGhost || undefined}
    >
      {isGhost ? (
        <User size={size === 'hero' ? 26 : 14} strokeWidth={1.75} />
      ) : (
        initialsOf(username)
      )}
    </span>
  )
  const label = isGhost ? NO_OPPONENT_LABEL : username

  if (size === 'hero') {
    return (
      <div className={`md-hero__player md-hero__player--${align}`}>
        <div className="md-hero__player-row">
          {avatar}
          <div className={`md-hero__player-text--${align}`}>
            <div
              className={nameVariants({ size, state })}
              data-won={state === 'win' || undefined}
            >
              {label}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="md-games__player min-w-0">
      {avatar}
      <span
        className={nameVariants({ size, state })}
        data-won={state === 'win' || undefined}
      >
        {label}
      </span>
    </div>
  )
}
