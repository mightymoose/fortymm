import { render, screen, type Container } from '@/test/utilities'

import { cardPage } from './card.page'
import { EmptyCard, type EmptyCardProps } from './empty-card'
import { buildEmptyCardProps } from './empty-card.factory'

const scoped = (container: Container) => ({
  ...cardPage.within(container),
  /** The overline label text node carrying `text`. */
  getOverline(text: string | RegExp) {
    return container.getByText(text)
  },
  /** The muted body line text node carrying `text`. */
  getBody(text: string | RegExp) {
    return container.getByText(text)
  },
})

/**
 * Test page-object for `EmptyCard` — a `Card` surface holding an overline label
 * and a muted body line, neither with a role of its own, so accessors resolve
 * them by rendered text. Composes `cardPage` for the underlying surface queries.
 */
export const emptyCardPage = {
  render(overrides: Partial<EmptyCardProps> = {}) {
    render(<EmptyCard {...buildEmptyCardProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
