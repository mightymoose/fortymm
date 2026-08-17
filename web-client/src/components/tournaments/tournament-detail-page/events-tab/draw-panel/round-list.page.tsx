import { render, screen, type Container } from '@/test/utilities'

import { RoundList, type RoundListProps } from './round-list'
import { buildRoundListProps } from './round-list.factory'
import { fixtureLinePage, fixtureLineTexts } from './round-list/fixture-line.page'

const scoped = (container: Container) => ({
  /** The list of one round's fixtures, by its accessible name — the name is what tells
   * Group A's round 1 from Group B's when both are on the page. */
  getRound(round: number, groupName: string) {
    return container.getByRole('list', {
      name: `Round ${round} fixtures in ${groupName}`,
    })
  },
  queryRound(round: number, groupName: string) {
    return container.queryByRole('list', {
      name: `Round ${round} fixtures in ${groupName}`,
    })
  },
  /** One round's fixtures, as text (`player.1 vs player.4`), in the order they render. */
  getRoundLines(round: number, groupName: string) {
    return fixtureLineTexts(
      container.getByRole('list', {
        name: `Round ${round} fixtures in ${groupName}`,
      }),
    )
  },
  /** The rounds' accessible names, in DOM order — the assertion that a draw is grouped
   * *and ordered*, not merely present. */
  getRoundNames(): string[] {
    return container
      .queryAllByTestId(/^draw-round-/)
      .map((list: HTMLElement) => list.getAttribute('aria-label') ?? '')
  },
  // Every fixture line in scope, in DOM order — a grouping assertion needs the whole
  // sequence, not one round at a time.
  ...fixtureLinePage.within(container),
})

/** Test page-object for `RoundList`. */
export const roundListPage = {
  render(overrides: Partial<RoundListProps> = {}) {
    render(<RoundList {...buildRoundListProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
