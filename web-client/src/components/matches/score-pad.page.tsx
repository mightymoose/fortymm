import { render, screen, type Container } from '@/test/utilities'

import { ScorePad, type ScorePadProps } from './score-pad'
import { buildScorePadProps } from './score-pad.factory'

const scoped = (container: Container) => ({
  /** A side's numeric input, by the participant's name (the field's
   * accessible label is `"<name> score"`). */
  getInput(name: string) {
    return container.getByLabelText(`${name} score`) as HTMLInputElement
  },
  /** The primary submit button, by its current label. */
  getSubmit(label: string) {
    return container.getByRole('button', { name: label })
  },
  /** The secondary "Clear" action — only present when `onClear` is supplied. */
  queryClear() {
    return container.queryByRole('button', { name: 'Clear' })
  },
  /** The games tally under the VS divider, or null when hidden. */
  queryGamesTally() {
    return container.queryByText('VS')?.parentElement?.querySelector('.se-games')
  },
  /** Every visible `role="alert"` line (score error + both-required hint). */
  queryAlerts() {
    return container.queryAllByRole('alert')
  },
})

/**
 * Test page-object for `ScorePad` — the shared two-side score-input form. Pure
 * presentational, so `render` mounts it directly (no router/suspense harness).
 */
export const scorePadPage = {
  render(overrides: Partial<ScorePadProps> = {}) {
    const props = buildScorePadProps(overrides)
    render(<ScorePad {...props} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
