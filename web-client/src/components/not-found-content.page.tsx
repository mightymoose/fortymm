import { render, screen, type Container } from '@/test/utilities'

import {
  NotFoundContent,
  type NotFoundContentProps,
} from './not-found-content'
import { buildNotFoundContentProps } from './not-found-content.factory'

const scoped = (container: Container) => ({
  /** The mono eyebrow above the headline. Always reads "404". */
  getCode() {
    return container.getByText('404')
  },
  /** The big display headline — the only `<h1>` the body renders. */
  getHeadline() {
    return container.getByRole('heading', { level: 1 })
  },
  /** The explanatory sentence beneath the headline. */
  getBody(text: string | RegExp) {
    return container.getByText(text)
  },
  /**
   * The mono meta line, addressed by its `aria-label` (the root 404 labels it
   * "Requested path"). `query*` returns null when the caller passed no `meta`.
   */
  queryMeta(label: string) {
    return container.queryByLabelText(label)
  },
  /**
   * Every link in the body. The design allows exactly **one** recovery action,
   * so tests assert on the length as much as on the target.
   */
  getActions() {
    return container.queryAllByRole('link')
  },
  /**
   * The `<main>` landmarks in scope. `NotFoundContent` renders **none** of its
   * own — the shell owns the landmark — which is what makes it safe to render
   * inside a route that already sits under `AppShell`.
   */
  getMainLandmarks() {
    return container.queryAllByRole('main')
  },
})

/**
 * Test page-object for `NotFoundContent` — the shell-less 404 body. It renders
 * no TanStack `<Link>` of its own (the recovery action is passed in), so the
 * default render needs no router harness and tests read synchronously.
 */
export const notFoundContentPage = {
  render(overrides: Partial<NotFoundContentProps> = {}) {
    const props = buildNotFoundContentProps(overrides)
    render(<NotFoundContent {...props} />)
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed this body (the root
   * `NotFoundPage`, and any route-level variant) spread this to expose the
   * same queries as their own rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
