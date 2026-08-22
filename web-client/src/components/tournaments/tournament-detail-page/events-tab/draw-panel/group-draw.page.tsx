import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, within, type Container } from '@/test/utilities'

import { GroupDraw, type GroupDrawProps } from './group-draw'
import { buildGroupDrawProps } from './group-draw.factory'
import { roundListPage } from './round-list.page'
import { fixtureLineTexts } from './round-list/fixture-line.page'

const scoped = (container: Container) => ({
  /** The group's whole section, by group id — the scope every "in *this* group"
   * assertion narrows to, since a draw renders several of these side by side. */
  getGroup(groupId: string) {
    return container.getByTestId(`group-draw-${groupId}`)
  },
  queryGroup(groupId: string) {
    return container.queryByTestId(`group-draw-${groupId}`)
  },
  /** The group's heading — its position-derived label ("Group A"). */
  getGroupHeading(groupLabel: string) {
    return container.getByRole('heading', { name: groupLabel })
  },
  /** Every group's heading, **in DOM order** — the sequence a director reads top to
   * bottom, which is the whole claim `Group.position` exists to make (`groupLabel`,
   * `data/draw`). Named accessors cannot state it: `getGroupHeading('Group B')` passes
   * just as happily when Group B is rendered tenth. */
  getGroupNames(): string[] {
    return container
      .queryAllByTestId(/^group-draw-/)
      .map((group: HTMLElement) =>
        (within(group).getByRole('heading').textContent ?? '').trim(),
      )
  },
  /** The group's entrants, in the order they render (draw order: seed, then
   * registration). Names, not ids — a chip list of uuids would pass a "renders the
   * roster" assertion and tell a director nothing. */
  getGroupEntrants(groupLabel: string) {
    return within(container.getByRole('list', { name: `Entrants in ${groupLabel}` }))
      .getAllByRole('listitem')
      .map((li) => (li.textContent ?? '').trim())
  },
  /** Every fixture line inside one group, in DOM order — the sequence *is* the draw. */
  getGroupLines(groupId: string) {
    return fixtureLineTexts(container.getByTestId(`group-draw-${groupId}`))
  },
  /** Everything interactive in the group. Must always be empty: a fixture is a planned
   * pairing, not a match, and the group scaffold has no controls of its own — the draw's
   * actions live in the panel's header. */
  getGroupControls(groupId: string) {
    return interactiveElementsIn(container.getByTestId(`group-draw-${groupId}`))
  },
  // The round accessors (`getRoundLines`, `getRoundNames`) come from the round list.
  ...roundListPage.within(container),
})

/** Test page-object for `GroupDraw`. */
export const groupDrawPage = {
  render(overrides: Partial<GroupDrawProps> = {}) {
    render(<GroupDraw {...buildGroupDrawProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
