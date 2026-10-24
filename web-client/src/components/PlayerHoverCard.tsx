import { useId } from 'react'
import { Avatar, type AvatarTone } from './Avatar'

export type PlayerPreview = {
  name: string
  club: string
  joinedYear: number
  rating: number
  wins: number
  losses: number
}

// The preview a hover card shows over a player's name: their avatar, name,
// club and the year they joined, then their rating and win-loss record. A
// `.hover-card` group named by the player (styles/base.css). `tone` colors
// the avatar. It's shown in place, open. It doesn't open on hover, or close.
export function PlayerHoverCard({
  player,
  tone,
}: {
  player: PlayerPreview
  tone?: AvatarTone
}) {
  const nameId = useId()
  return (
    <div role="group" aria-labelledby={nameId} className="hover-card">
      <div className="row hover-card-header">
        <Avatar name={player.name} size="lg" tone={tone} />
        <div>
          <h4 id={nameId} className="hover-card-name">
            {player.name}
          </h4>
          <p className="hover-card-meta">
            {player.club} · Joined {player.joinedYear}
          </p>
        </div>
      </div>
      <dl className="row hover-card-stats">
        <div>
          <dt>Rating</dt>{' '}
          <dd className="hover-card-rating">{player.rating}</dd>
        </div>
        <div>
          <dt>W-L</dt>{' '}
          <dd>
            {player.wins}–{player.losses}
          </dd>
        </div>
      </dl>
    </div>
  )
}
