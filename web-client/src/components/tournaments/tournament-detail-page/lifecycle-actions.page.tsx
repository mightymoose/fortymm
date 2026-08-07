import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { confirmIrreversibleActDialogPage } from './confirm-irreversible-act-dialog.page'
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

  /** Every control in the component's own root, swept by **DOM** rather than by role.
   * The sweep an "is the button still live?" claim needs while the confirm is open:
   * Radix marks everything behind a modal `aria-hidden`, so `queryAllByRole('button')`
   * finds none of them and would pass vacuously. The dialog portals to the body, i.e.
   * outside this root, so it never joins the count.
   *
   * ⚠️ Requires the component to have rendered something. It **throws** for a non-owner
   * and for the terminal `archived`, where `LifecycleActions` returns `null` and there is
   * no root to sweep. Those two cases want `queryAllButtons()`, whose `[]` is the
   * assertion. */
  getActionControls() {
    return interactiveElementsIn(container.getByTestId('lifecycle-actions'))
  },

  /** The **confirm** every lifecycle edge is gated by — the button opens it and sends
   * nothing; the transition is fired by the dialog's own button. Always addressed at
   * `screen`, whatever the scope: the dialog portals to the document body. */
  confirm: confirmIrreversibleActDialogPage.within(screen),

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
  /** The same notice, found by **testid** rather than by role — the accessor a test needs
   * while the confirm is open. Radix marks everything behind a modal `aria-hidden`, so
   * `queryByRole('alert')` finds nothing there and would report a standing refusal as
   * gone. This one reads the DOM, where it actually still is. */
  queryNoticeElement() {
    return container.queryByTestId('lifecycle-notice')
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
 *
 * A test driving any of the three edges must go through `confirm`: clicking the lifecycle
 * button alone opens the dialog and sends nothing, which is the whole point of it.
 */
export const lifecycleActionsPage = {
  /** Mount the header action. Returns the render result, plus `rerenderWith` — the only
   * honest way to say "the tournament changed **underneath** this component", which is
   * what a refetch landing under an open confirm does.
   *
   * ⚠️ Calling `render` a second time does NOT replace the first tree: Testing Library
   * appends a second one and `screen` spans the whole body, so the queries would find two
   * `lifecycle-actions` roots and the assertion would be about the wrong one (or throw on
   * the ambiguity). Prop-change claims use this. */
  render(overrides: Partial<LifecycleActionsProps> = {}) {
    const utils = render(
      <LifecycleActions {...buildLifecycleActionsProps(overrides)} />,
    )
    return {
      ...utils,
      rerenderWith(next: Partial<LifecycleActionsProps> = {}) {
        utils.rerender(
          <LifecycleActions {...buildLifecycleActionsProps(next)} />,
        )
      },
    }
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
