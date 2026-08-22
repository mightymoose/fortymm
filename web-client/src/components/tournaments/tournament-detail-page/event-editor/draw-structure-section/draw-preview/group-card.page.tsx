import { render, screen, type Container } from '@/test/utilities'

import { GroupCard, type GroupCardProps } from './group-card'
import { buildGroupCardProps } from './group-card.factory'

const scoped = (container: Container) => ({
  /** The card itself. */
  getCard() {
    return container.getByTestId('draw-preview-group-card')
  },
  /** The `Too small` line — **absent** on a group that can be played. The bad state is
   * read as text on purpose: a colour is no state at all to a screen reader. */
  queryTooSmall() {
    return container.queryByText('Too small')
  },
  /** The `top {q} advance` line, which wears the advancing green only on a group that can
   * actually supply those qualifiers. */
  getAdvanceLine() {
    return container.getByText(/^top \d+ advance$/)
  },
})

/** Test page-object for `GroupCard`. The card is an `<li>`, so `render` puts it in a list
 * — the same parent `DrawPreview` gives it. */
export const groupCardPage = {
  render(overrides: Partial<GroupCardProps> = {}) {
    render(
      <ul>
        <GroupCard {...buildGroupCardProps(overrides)} />
      </ul>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
