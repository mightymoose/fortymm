import { render, screen, type Container } from '@/test/utilities'

import {
  ProfileHeroDisplay,
  type ProfileHeroDisplayProps,
} from './profile-hero-display'
import { buildProfileHeroDisplayProps } from './profile-hero-display.factory'

const scoped = (container: Container) => ({
  /** The player's name — the page's `<h1>`. Named by the username itself (the
   * trailing Bebas dot is `aria-hidden`). */
  getName(username: string) {
    return container.getByRole('heading', { level: 1, name: username })
  },
  queryName(username: string) {
    return container.queryByRole('heading', { level: 1, name: username })
  },
  /** The "Member since Mar 2024" line. Absent when the join date is
   * unreadable. */
  queryMemberSince() {
    return container.queryByText(/^Member since /)
  },
})

/**
 * Test page-object for `ProfileHeroDisplay` — the pure view-in, DOM-out
 * identity half of the hero.
 */
export const profileHeroDisplayPage = {
  render(overrides: Partial<ProfileHeroDisplayProps> = {}) {
    const props = buildProfileHeroDisplayProps(overrides)
    render(<ProfileHeroDisplay {...props} />)
  },

  /** Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. The fetcher and wrapper page objects spread this
   * rather than re-deriving the queries. */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
