import { UserAvatar } from '@/components/ui/user-avatar'

import { type ProfileHeroView } from './profile-hero-query'

export interface ProfileHeroDisplayProps {
  hero: ProfileHeroView
}

/**
 * The identity half of the profile hero: avatar, username and when they joined.
 * Pure view-in, DOM-out — every label it renders was derived in
 * `selectProfileHero`.
 *
 * The username is rendered bare (web-client/CLAUDE.md — never `@`-prefixed) and
 * in its real casing; the display-caps are CSS (`text-transform`), so the
 * heading's accessible name is the username itself rather than a shouted
 * letter-by-letter reading of it. The trailing dot is pure Bebas flourish and is
 * hidden from the accessibility tree.
 */
export const ProfileHeroDisplay = ({ hero }: ProfileHeroDisplayProps) => (
  <div className="player-profile__identity">
    <div className="player-profile__avatar-ring">
      <UserAvatar name={hero.username} size={120} ring />
      <span aria-hidden="true" className="player-profile__avatar-dashed" />
    </div>
    <div className="player-profile__name-wrap">
      <div className="player-profile__overline">FortyMM Player</div>
      <h1 className="player-profile__name">
        {hero.username}
        <span aria-hidden="true" className="player-profile__name-dot">
          .
        </span>
      </h1>
      {hero.memberSince && (
        <p className="player-profile__member-since">{hero.memberSince}</p>
      )}
    </div>
  </div>
)
