import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

import { MatchRowLink, type MatchRowLinkProps } from './match-row-link'
import { buildMatchRowLinkProps } from './match-row-link.factory'

/** The route the row opens. Registered as a stub by every harness that mounts a
 * component containing a `MatchRowLink`, so the typed `<Link>` resolves. */
export const MATCH_DETAIL_ROUTE = '/matches/$matchId'

const scoped = (container: Container) => ({
  /** The row's one and only link. Pass the accessible name the row was built
   * with (`matchRowAriaLabel`), or omit for the factory default. */
  getMatchLink(ariaLabel: string = buildMatchRowLinkProps().ariaLabel) {
    return container.getByRole('link', { name: ariaLabel })
  },
  findMatchLink(ariaLabel: string = buildMatchRowLinkProps().ariaLabel) {
    return container.findByRole('link', { name: ariaLabel })
  },
  /** **Every** link in the scope. A row must expose exactly one: a stretched
   * anchor that a screen reader hears four times is the bug this component
   * exists to avoid. */
  getAllLinks() {
    return container.queryAllByRole('link')
  },
})

/**
 * Test page-object for `MatchRowLink` — the stretched, single-anchor row link.
 *
 * It renders a typed `<Link>`, so `render` mounts it under a memory router that
 * registers `/matches/$matchId`. The router resolves asynchronously: start tests
 * with `await matchRowLinkPage.findMatchLink()`.
 *
 * Parent page objects (both history rows) spread `within(container)` to reuse
 * these accessors against a row of their own.
 */
export const matchRowLinkPage = {
  render(overrides: Partial<MatchRowLinkProps> = {}) {
    const props = buildMatchRowLinkProps(overrides)
    return renderWithRoutes(
      <table>
        <tbody>
          <tr>
            <td>
              <MatchRowLink {...props} />
            </td>
          </tr>
        </tbody>
      </table>,
      { linkTargets: [MATCH_DETAIL_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
