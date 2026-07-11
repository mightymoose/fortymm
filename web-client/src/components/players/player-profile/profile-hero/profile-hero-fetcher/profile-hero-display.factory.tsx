import type { ProfileHeroDisplayProps } from './profile-hero-display'
import type { ProfileHeroView } from './profile-hero-query'

/** The identity card of a player who joined in March 2024. */
export function buildProfileHeroView(
  overrides: Partial<ProfileHeroView> = {},
): ProfileHeroView {
  return {
    username: 'rita.kovac',
    memberSince: 'Member since Mar 2024',
    ...overrides,
  }
}

/** Props for `ProfileHeroDisplay`. */
export function buildProfileHeroDisplayProps(
  overrides: Partial<ProfileHeroDisplayProps> = {},
): ProfileHeroDisplayProps {
  return { hero: buildProfileHeroView(), ...overrides }
}
