import { render, screen, type Container } from '@/test/utilities'

import { Card, type CardProps } from './card'
import { buildCardProps } from './card.factory'

const scoped = (container: Container) => ({
  /** The card surface element — a bare-string child renders as a direct text
   * node of the shadcn Card `div`, so querying that text resolves the surface
   * itself (the element the layout styles sit on). */
  getBody(text: string | RegExp) {
    return container.getByText(text)
  },
  queryBody(text: string | RegExp) {
    return container.queryByText(text)
  },
})

/**
 * Test page-object for `Card` — a styled surface (a shadcn Card `div`) with no
 * role of its own, so accessors resolve its body by rendered text and its
 * surface by a `data-testid` spread through `...rest`. Owners that embed `Card`
 * spread `within` to read the same queries.
 */
export const cardPage = {
  render(overrides: Partial<CardProps> = {}) {
    render(<Card {...buildCardProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
