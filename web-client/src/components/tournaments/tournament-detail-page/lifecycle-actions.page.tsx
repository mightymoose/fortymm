import { StrictMode } from 'react'

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
  /** The notice as one normalised string, **synchronously** — `''` when there is none.
   * For the tests that assert a refusal is STILL on screen after fresh server data: a
   * refusal already shown does not need waiting for, and an `await find…` there would red
   * as a five-second timeout rather than as "the notice is gone"
   * (`web-client/CLAUDE.md`: an undiscriminated red proves nothing). */
  queryNoticeText() {
    const notice = container.queryByRole('alert')
    return (notice?.textContent ?? '').replace(/\s+/g, ' ').trim()
  },
  /** Which designed case the refusal fell into (`LifecycleRefusal['kind']`) — so a test
   * can pin "this rendered the 403 state", not merely "some words appeared". */
  async findNoticeKind() {
    const notice = await container.findByTestId('lifecycle-notice')
    return notice.getAttribute('data-kind')
  },
})

/** The component under `StrictMode`, because its refusal is held by a hook that keeps the
 * state-stamp in a ref written from an effect (`../data/expiring-notice`): a mount →
 * cleanup → remount must leave that ref correct, and only the double-invoke shows it
 * (`web-client/CLAUDE.md`). */
const mount = (props: LifecycleActionsProps) => (
  <StrictMode>
    <LifecycleActions {...props} />
  </StrictMode>
)

/**
 * Test page-object for `LifecycleActions`.
 *
 * The component owns the transition mutation, so a test that clicks its button must stub
 * the transitions endpoint itself — `mockTournamentTransitionEndpoint`
 * (`@/mocks/endpoints/tournaments/tournaments.endpoint`). Rendering alone fetches
 * nothing.
 */
export const lifecycleActionsPage = {
  /** Render, and hand back the one thing a caller may do afterwards: hand the component
   * **fresh server data**, the way the detail page does when the tournament refetches.
   * That is how a refusal's expiry is exercised — nobody clicks anything for it. */
  render(overrides: Partial<LifecycleActionsProps> = {}) {
    const { rerender } = render(mount(buildLifecycleActionsProps(overrides)))
    return {
      rerender(next: Partial<LifecycleActionsProps> = {}) {
        rerender(mount(buildLifecycleActionsProps(next)))
      },
    }
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
