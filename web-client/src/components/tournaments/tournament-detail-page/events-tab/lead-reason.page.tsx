import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { LeadReason, type LeadReasonProps } from './lead-reason'
import { buildLeadReasonProps } from './lead-reason.factory'

const scoped = (container: Container) => ({
  /** The notice itself — addressed by test id, because it is deliberately inert
   * text with no role of its own. */
  getNotice() {
    return container.getByTestId('lead-reason')
  },
  /** Everything interactive inside it. Must always be empty: a reason is not a
   * dead-end button (ADR 0015). */
  getControls() {
    return interactiveElementsIn(container.getByTestId('lead-reason'))
  },
})

/** Test page-object for `LeadReason`. */
export const leadReasonPage = {
  render(overrides: Partial<LeadReasonProps> = {}) {
    render(
      <LeadReason
        {...buildLeadReasonProps({ testId: 'lead-reason', ...overrides })}
      />,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
