import { render, screen, within, type Container } from '@/test/utilities'

import { PlayerChip, type PlayerChipProps } from './player-chip'
import { buildPlayerChipProps } from './player-chip.factory'

const scoped = (container: Container, root: ParentNode) => ({
  /** The side's display label rendered as the `.player-name` text. Pass the
   * label the chip was built with (e.g. 'rita.kovac', 'No opponent'). */
  getPlayerName(name: string) {
    return container.getByText(name)
  },
  queryPlayerName(name: string) {
    return container.queryByText(name)
  },
  /** The rendered `UserAvatar` for a present side — a `role="img"` whose
   * accessible name is the side label. Absent for an empty side (which renders
   * the aria-hidden ghost instead). */
  getRenderedAvatar(name: string) {
    return container.getByRole('img', { name })
  },
  queryRenderedAvatar(name: string) {
    return container.queryByRole('img', { name })
  },
  /** The dashed ghost avatar shown for an empty side. It is `aria-hidden` with
   * no role or accessible name, so a class query is the only handle — this is a
   * deliberate last resort, used to assert the empty-side branch. */
  queryGhostAvatar() {
    return root.querySelector('.player-avatar--ghost')
  },
})

/**
 * Test page-object for `PlayerChip` — the avatar + name for one side of a match
 * row. No router harness (leaf, renders no Link), so tests can read
 * synchronously after `render`.
 */
export const playerChipPage = {
  render(overrides: Partial<PlayerChipProps> = {}) {
    const props = buildPlayerChipProps(overrides)
    render(<PlayerChip {...props} />)
  },

  /**
   * Scope the accessors to a subtree. Pass the row's element so the embedding
   * row page object exposes these queries as its own (role/name queries scope
   * to the node; the class-only ghost query scopes to it too). Defaults to the
   * whole document.
   */
  within(node: HTMLElement) {
    return scoped(within(node), node)
  },

  ...scoped(screen, document.body),
}
