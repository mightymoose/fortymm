import userEvent from '@testing-library/user-event'
import { HttpResponse, delay } from 'msw'

import { waitFor } from '@/test/utilities'
import { buildAgentAccess } from '@/mocks/factories/settings/agent-access.factory'
import { disconnectButtonPage } from './disconnect-button.page'

const PENDING_NOTE = 'Disconnecting Claude…'
const FAILURE_NOTE =
  "We couldn't disconnect Claude. Nothing has changed — try again in a moment."

/** Open the dialog the way a keyboard user does, so the focus claims below are
 * about the press that really opened it. */
async function openWithKeyboard() {
  await userEvent.tab()
  expect(disconnectButtonPage.getDisconnectButton()).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await disconnectButtonPage.findDialog()
}

describe('DisconnectButton', () => {
  it('disconnects nothing on its own — the press only asks', async () => {
    const calls: string[] = []
    disconnectButtonPage.mockEndpoint(({ request }) => {
      calls.push(request.method)
      return HttpResponse.json(buildAgentAccess({ state: 'revoked' }))
    })
    disconnectButtonPage.render()

    expect(disconnectButtonPage.queryDialog()).toBeNull()
    await disconnectButtonPage.clickDisconnect()

    expect(await disconnectButtonPage.findDialog()).toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it('keeps Tab inside the dialog, in both directions', async () => {
    disconnectButtonPage.render()
    await openWithKeyboard()

    const dismiss = disconnectButtonPage.getDismissButton()
    const confirm = disconnectButtonPage.getConfirmButton()
    // Focus enters the dialog on its first control rather than being left on
    // the trigger behind it.
    expect(dismiss).toHaveFocus()

    await userEvent.tab()
    expect(confirm).toHaveFocus()
    // The trap: past the last control, Tab wraps to the first instead of
    // walking out into the page behind.
    await userEvent.tab()
    expect(dismiss).toHaveFocus()
    // And backwards out of the first, which is the direction a trap is most
    // often missing.
    await userEvent.tab({ shift: true })
    expect(confirm).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(dismiss).toHaveFocus()
  })

  it('puts the page behind it out of reach while it is open', async () => {
    disconnectButtonPage.render()
    const trigger = disconnectButtonPage.getDisconnectButton()

    await disconnectButtonPage.clickDisconnect()
    await disconnectButtonPage.findDialog()

    // Screen reader: everything outside the dialog's portal is hidden from the
    // accessibility tree, the trigger included.
    expect(trigger.closest('[aria-hidden="true"]')).not.toBeNull()
    // Pointer: the page behind takes no clicks — user-event refuses the press
    // for the same reason a real cursor would do nothing.
    expect(document.body.style.pointerEvents).toBe('none')
    await expect(userEvent.click(trigger)).rejects.toThrow(/pointer-events/)

    // …and both are given back on close, or the page would be dead afterwards.
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(disconnectButtonPage.queryDialog()).toBeNull())
    expect(trigger.closest('[aria-hidden="true"]')).toBeNull()
    expect(document.body.style.pointerEvents).not.toBe('none')
    await userEvent.click(trigger)
    expect(await disconnectButtonPage.findDialog()).toBeInTheDocument()
  })

  it('closes on Escape and gives focus back to the button that opened it', async () => {
    const calls: string[] = []
    disconnectButtonPage.mockEndpoint(({ request }) => {
      calls.push(request.method)
      return HttpResponse.json(buildAgentAccess({ state: 'revoked' }))
    })
    disconnectButtonPage.render()
    await openWithKeyboard()

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(disconnectButtonPage.queryDialog()).toBeNull())
    // Deferred by a tick on purpose: a focus() while the overlay still holds
    // focus is wiped by its unmount, so this only lands once the subtree has
    // gone.
    await waitFor(() =>
      expect(disconnectButtonPage.getDisconnectButton()).toHaveFocus(),
    )
    // Escape is a dismissal, not a quiet confirmation.
    expect(calls).toHaveLength(0)
  })

  it('gives focus back when the player keeps it connected', async () => {
    disconnectButtonPage.render()
    await openWithKeyboard()

    await disconnectButtonPage.clickDismiss()

    await waitFor(() => expect(disconnectButtonPage.queryDialog()).toBeNull())
    await waitFor(() =>
      expect(disconnectButtonPage.getDisconnectButton()).toHaveFocus(),
    )
  })

  it('asks the server to disconnect, then closes and gives focus back', async () => {
    const calls: string[] = []
    disconnectButtonPage.mockEndpoint(({ request }) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`)
      return HttpResponse.json(buildAgentAccess({ state: 'revoked' }))
    })
    disconnectButtonPage.render()
    await openWithKeyboard()

    await disconnectButtonPage.clickConfirm()

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatch(
      /^POST .*\/v1\/settings\/agent-access\/disconnect$/,
    )
    await waitFor(() => expect(disconnectButtonPage.queryDialog()).toBeNull())
    // Standalone, so nothing unmounts the trigger — on the real page the
    // connected card goes with the state, which is what the page test asserts.
    await waitFor(() =>
      expect(disconnectButtonPage.getDisconnectButton()).toHaveFocus(),
    )
  })

  it('says the disconnect is under way, and refuses a second press meanwhile', async () => {
    disconnectButtonPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(buildAgentAccess({ state: 'revoked' }))
    })
    disconnectButtonPage.render()
    await disconnectButtonPage.clickDisconnect()
    await disconnectButtonPage.findDialog()

    await disconnectButtonPage.clickConfirm()

    expect(disconnectButtonPage.getConfirmNote()).toHaveTextContent(
      PENDING_NOTE,
    )
    // A second POST would buy nothing and lose the first request's answer.
    expect(disconnectButtonPage.getConfirmButton()).toBeDisabled()
    await waitFor(() => expect(disconnectButtonPage.queryDialog()).toBeNull())
  })

  it('stays open and says so when the disconnect is refused', async () => {
    disconnectButtonPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    )
    disconnectButtonPage.render()
    await disconnectButtonPage.clickDisconnect()
    await disconnectButtonPage.findDialog()

    await disconnectButtonPage.clickConfirm()

    await waitFor(() =>
      expect(disconnectButtonPage.getConfirmNote()).toHaveTextContent(
        FAILURE_NOTE,
      ),
    )
    // Closing here would tell the player their agent is disconnected when it
    // is not — the one failure a destructive action must never have.
    expect(disconnectButtonPage.queryDialog()).toBeInTheDocument()
    expect(disconnectButtonPage.getConfirmButton()).toBeEnabled()
  })

  it('refuses a payload it cannot trust rather than claim the switch flipped', async () => {
    // The endpoint's contract says it returns the page's whole new state; a
    // body that isn't one is a failure, not a success with holes.
    disconnectButtonPage.mockEndpoint(() =>
      HttpResponse.json({ state: 'nonsense' } as never),
    )
    disconnectButtonPage.render()
    await disconnectButtonPage.clickDisconnect()
    await disconnectButtonPage.findDialog()

    await disconnectButtonPage.clickConfirm()

    await waitFor(() =>
      expect(disconnectButtonPage.getConfirmNote()).toHaveTextContent(
        FAILURE_NOTE,
      ),
    )
    expect(disconnectButtonPage.queryDialog()).toBeInTheDocument()
  })

  it('does not greet the next press with the last attempt’s failure', async () => {
    disconnectButtonPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    )
    disconnectButtonPage.render()
    await disconnectButtonPage.clickDisconnect()
    await disconnectButtonPage.findDialog()
    await disconnectButtonPage.clickConfirm()
    await waitFor(() =>
      expect(disconnectButtonPage.getConfirmNote()).toHaveTextContent(
        FAILURE_NOTE,
      ),
    )

    await disconnectButtonPage.clickDismiss()
    await waitFor(() => expect(disconnectButtonPage.queryDialog()).toBeNull())
    await disconnectButtonPage.clickDisconnect()
    await disconnectButtonPage.findDialog()

    expect(disconnectButtonPage.getConfirmNote()).toBeEmptyDOMElement()
  })
})
