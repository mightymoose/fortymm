import userEvent from '@testing-library/user-event'

import { render, screen, type Container } from '@/test/utilities'
import {
  mockDisconnectAgentAccessEndpoint,
  type AgentAccessResolver,
} from '@/mocks/endpoints/settings/agent-access.endpoint'
import { server } from '@/mocks/server'
import { DisconnectButton } from './disconnect-button'
import { disconnectDialogPage } from './disconnect-dialog.page'

/** The trigger's accessible name — the same words the dialog's destructive
 * button carries, on purpose. */
const DISCONNECT_LABEL = 'Disconnect Claude'

const scoped = (container: Container) => {
  /**
   * The trigger, and only the trigger.
   *
   * `hidden: true` because while the dialog is open the trigger is deliberately
   * *out* of the accessibility tree (that is half of "the page behind is
   * unreachable"), so the default role query stops finding it exactly when a
   * test most wants to check where focus went. That widened query then also
   * matches the dialog's identically-named confirm button, so the filter is on
   * the property that makes this one a trigger: `aria-haspopup="dialog"`.
   */
  const triggers = (): HTMLElement[] =>
    container
      .queryAllByRole('button', { name: DISCONNECT_LABEL, hidden: true })
      .filter(
        (button: HTMLElement) =>
          button.getAttribute('aria-haspopup') === 'dialog',
      )

  return {
    /** The connected card's Disconnect button. Throws where it must exist. */
    getDisconnectButton() {
      const [trigger] = triggers()
      if (!trigger) throw new Error('The Disconnect Claude button is absent.')
      return trigger
    },
    /** The same, for asserting **absence** — no other status offers it. */
    queryDisconnectButton() {
      return triggers()[0] ?? null
    },
    /** Open the confirmation with the pointer. */
    async clickDisconnect() {
      const [trigger] = triggers()
      if (!trigger) throw new Error('The Disconnect Claude button is absent.')
      await userEvent.click(trigger)
    },
    // The dialog's own accessors. Portalled to `<body>`, so these only resolve
    // against a `screen`-scoped container — which every composition of this
    // object uses.
    ...disconnectDialogPage.within(container),
  }
}

/**
 * Test page-object for `DisconnectButton` — the trigger, its dialog and the
 * mutation behind it, which is the unit every keyboard and focus claim is
 * about.
 *
 * It owns a mutation, so a test must stub `POST
 * /v1/settings/agent-access/disconnect` with `mockEndpoint` before confirming —
 * `handlers.ts` has a default, so an unstubbed confirm succeeds rather than
 * erroring.
 *
 * Rendered **standalone**, which is the one difference from the real page worth
 * knowing: there, a successful disconnect re-renders the whole page as
 * `revoked` and takes the connected card (and this trigger) with it. Here
 * nothing unmounts, so "focus returns to the button that opened it" is
 * observable on the confirm route too.
 */
export const disconnectButtonPage = {
  /** Override `POST /v1/settings/agent-access/disconnect` for this test. */
  mockEndpoint(resolver: AgentAccessResolver) {
    mockDisconnectAgentAccessEndpoint(server, resolver)
  },

  render() {
    render(<DisconnectButton />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
