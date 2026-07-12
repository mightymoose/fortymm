import type { CSSProperties } from 'react'

import { UserAvatar } from '@/components/ui/user-avatar'

import { type ProfileHeroView } from './profile-hero-query'

/**
 * The hero avatar is the one place the ball itself stands in for a person: the
 * profile has exactly one subject, so it wears the brand gradient rather than
 * `UserAvatar`'s per-name hue — which exists to tell a *list* of people apart,
 * and which the opponent avatars on Recent matches keep for that reason.
 */
const BALL: CSSProperties = {
  background:
    'radial-gradient(circle at 35% 30%, #ffb57a, #ff7a1a 55%, #b94700)',
  color: 'var(--ink-950)',
  boxShadow:
    '0 0 0 1px rgba(255, 181, 122, 0.4), 0 0 32px rgba(255, 122, 26, 0.25)',
}

export interface ProfileHeroDisplayProps {
  hero: ProfileHeroView
}

/**
 * The identity half of the profile hero: avatar, username and a meta line.
 * Pure view-in, DOM-out — every label it renders was derived in
 * `selectProfileHero`.
 *
 * The username is rendered bare (web-client/CLAUDE.md — never `@`-prefixed) and
 * in its real casing. The trailing dot is a brand flourish and is hidden from
 * the accessibility tree.
 *
 * "Member since …" keeps an element of its own inside the meta line rather than
 * being concatenated into one string with the role: it is the line a reader
 * looks up on its own.
 */
export const ProfileHeroDisplay = ({ hero }: ProfileHeroDisplayProps) => (
  <div className="player-profile__identity">
    <UserAvatar
      name={hero.username}
      size={82}
      className="player-profile__avatar"
      style={BALL}
    />
    <div className="player-profile__name-wrap">
      <h1 className="player-profile__name">
        {hero.username}
        <span aria-hidden="true" className="player-profile__name-dot">
          .
        </span>
      </h1>
      <p className="player-profile__meta">
        <span>Player</span>
        {hero.memberSince && (
          <>
            <span aria-hidden="true" className="player-profile__meta-sep">
              ·
            </span>
            <span>{hero.memberSince}</span>
          </>
        )}
      </p>
    </div>
  </div>
)
