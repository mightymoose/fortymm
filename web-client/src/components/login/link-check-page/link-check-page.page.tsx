import { render, screen, type Container } from '@/test/utilities'

import { LinkCheckPage, type LinkCheckPageProps } from './link-check-page'

const scoped = (container: Container) => ({
  root() {
    return container.queryByTestId('link-check-page')
  },
  /** The resolved state, read off the root's `data-state`. */
  state() {
    return this.root()?.getAttribute('data-state') ?? null
  },
  /** The status disc's kind: `spin` | `check` | `x`. */
  discKind() {
    return container.queryByTestId('link-check-disc')?.getAttribute('data-kind') ?? null
  },
  heading() {
    return container.queryByRole('heading', { level: 1 })
  },
  /** All visible text — used to assert a token string never leaks into the UI. */
  text() {
    return this.root()?.textContent ?? ''
  },
})

/**
 * Test page-object for the presentational `LinkCheckPage`. No network — the
 * route drives `state`/`footer`, so tests render the view directly and assert
 * the disc kind, headline, and that no bearer token is ever shown.
 */
export const linkCheckPage = {
  render(props: LinkCheckPageProps) {
    render(<LinkCheckPage {...props} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
