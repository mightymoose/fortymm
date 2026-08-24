import { render, screen, type Container } from '@/test/utilities'

import { Honeypot, type HoneypotProps } from './honeypot'
import { buildHoneypotProps } from './honeypot.factory'

const scoped = (container: Container) => ({
  /** The trap input — real, parseable DOM a bot could fill. */
  getInput() {
    return container.getByTestId('honeypot')
  },
  /** The off-screen wrapper carrying the hiding attributes. */
  getWrapper() {
    return container
      .getByTestId('honeypot')
      .closest('div') as HTMLElement | null
  },
  /** The trap input resolved through its label — proves the label-to-input
   * association a bot's form parser would follow still holds. */
  getLabelledInput() {
    return container.getByLabelText('Leave this empty')
  },
  /**
   * The input as assistive tech sees it. Always null while the trap is hidden:
   * `*ByRole` skips `aria-hidden`/`inert` subtrees, which is the same lens a
   * screen reader uses.
   */
  queryAccessibleTextbox() {
    return container.queryByRole('textbox', { name: /leave this empty/i })
  },
})

/**
 * Test page-object for `Honeypot` — the imperceptible bot trap mounted by the
 * email forms. Renders synchronously; no router or suspense harness needed.
 */
export const honeypotPage = {
  render(overrides: Partial<HoneypotProps> = {}) {
    const props = buildHoneypotProps(overrides)
    render(<Honeypot {...props} />)
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree.
   */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
