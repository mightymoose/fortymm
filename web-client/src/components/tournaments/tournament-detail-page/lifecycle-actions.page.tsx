import { render, screen, type Container } from '@/test/utilities'

import { LifecycleActions, type LifecycleActionsProps } from './lifecycle-actions'
import { buildLifecycleActionsProps } from './lifecycle-actions.factory'

const scoped = (container: Container) => ({
  /** The one lifecycle button on offer — there is never more than one, because
   * a status has at most one legal edge out of it (ADR-0017). */
  getLifecycleButton(name: RegExp) {
    return container.getByRole('button', { name })
  },
  queryLifecycleButton(name: RegExp) {
    return container.queryByRole('button', { name })
  },
  /** Every button the component renders — `[]` for a non-owner and for the
   * terminal `archived`. */
  queryAllButtons() {
    return container.queryAllByRole('button')
  },

  /** The inline **refusal** — the 409 (a stale view, or go-live's precondition), and
   * every other failure, in the place the click happened. Found by role (`alert`),
   * which is the contract: it is the app talking back, and a screen reader must hear it
   * without hunting for it. */
  queryNotice() {
    return container.queryByRole('alert')
  },
  findNotice() {
    return container.findByRole('alert')
  },
  /** The notice as one normalised string — title *and* the sentence beneath it, since
   * the whole point of the 409 copy is that the second half **names the events** the
   * director has to go and fix. */
  async findNoticeText() {
    const notice = await container.findByRole('alert')
    return (notice.textContent ?? '').replace(/\s+/g, ' ').trim()
  },
  /** Which designed case the refusal fell into (`LifecycleRefusal['kind']`) — so a test
   * can pin "this rendered the 403 state", not merely "some words appeared". */
  async findNoticeKind() {
    const notice = await container.findByTestId('lifecycle-notice')
    return notice.getAttribute('data-kind')
  },
})

/**
 * Test page-object for `LifecycleActions`.
 *
 * The component owns the transition mutation, so a test that clicks its button must stub
 * the transitions endpoint itself — `mockTournamentTransitionEndpoint`
 * (`@/mocks/endpoints/tournaments/tournaments.endpoint`). Rendering alone fetches
 * nothing.
 */
export const lifecycleActionsPage = {
  render(overrides: Partial<LifecycleActionsProps> = {}) {
    render(<LifecycleActions {...buildLifecycleActionsProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
