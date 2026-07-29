import { disconnectDialogPage } from './disconnect-dialog.page'

/**
 * The three points, in full.
 *
 * Pinned here as whole sentences because each is load-bearing:
 *
 * - The **scope clause** in the first one is the reason this dialog can make the
 *   promise it makes. The binding is one Auth0 identity, so disconnecting stops
 *   every agent signed in with this email; only Claude can connect *today*
 *   (Auth0 Dynamic Client Registration is off), which is a config change, not a
 *   guarantee. A fragment assertion would pass just as happily against
 *   "Claude stops being able to read or change anything" — hence the whole
 *   sentence.
 * - The third one must not say the way back is redoing the connector steps:
 *   revocation is sticky, and only the re-allow control clears it.
 */
const POINTS = [
  'Claude — and any other AI assistant signed in with this email — stops being able to read or change anything on your account, immediately.',
  'Matches, results and draws it logged stay on your account — yours to edit or delete.',
  'You can switch Claude access back on whenever you like.',
]

const PENDING_NOTE = 'Disconnecting Claude…'
const FAILURE_NOTE =
  "We couldn't disconnect Claude. Nothing has changed — try again in a moment."

describe('DisconnectDialog', () => {
  it('asks the question by name, and is a modal dialog labelled by it', () => {
    disconnectDialogPage.render()

    const dialog = disconnectDialogPage.getDialog()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const heading = disconnectDialogPage.getConfirmHeading()
    expect(heading).toHaveTextContent('Disconnect Claude?')
    // Named by that heading rather than by a hand-written aria-label, so the
    // words a screen reader announces are the words on screen.
    expect(dialog).toHaveAttribute('aria-labelledby', heading.id)
  })

  it('says access stops for every AI assistant signed in with this email', () => {
    disconnectDialogPage.render()

    expect(disconnectDialogPage.getConfirmPoints()).toEqual(POINTS)
  })

  it('describes itself with those points, so they are announced with it', () => {
    disconnectDialogPage.render()

    const describedBy = disconnectDialogPage
      .getDialog()
      .getAttribute('aria-describedby')
    const description = describedBy
      ? document.getElementById(describedBy)
      : null
    expect(description).not.toBeNull()
    expect(description?.textContent).toContain(
      'any other AI assistant signed in with this email',
    )
  })

  it('never offers the connector steps as the way back on', () => {
    disconnectDialogPage.render()

    // Revocation is sticky: following the setup steps again gets a silent 401
    // forever, so copy that points at them is a dead end, not a reassurance.
    const said = disconnectDialogPage.getConfirmPoints().join(' ')
    expect(said).not.toMatch(/two fields/i)
    expect(said).not.toMatch(/connect again/i)
    expect(said).not.toMatch(/set (it|this) up again/i)
  })

  it('offers exactly two ways out, both of them named', () => {
    disconnectDialogPage.render()

    // In tab order, and no third control: a corner "×" would be an unnamed
    // repeat of "Keep it connected" on the one dialog where the choice matters.
    expect(
      disconnectDialogPage.getDialogButtons().map((b) => b.textContent),
    ).toEqual(['Keep it connected', 'Disconnect Claude'])
  })

  it('asks to close, and disconnects nothing, when the player keeps it connected', async () => {
    const onOpenChange = vi.fn()
    const onConfirm = vi.fn()
    disconnectDialogPage.render({ onConfirm }, { onOpenChange })

    await disconnectDialogPage.clickDismiss()

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('disconnects on the destructive button, and does not close itself', async () => {
    const onOpenChange = vi.fn()
    const onConfirm = vi.fn()
    disconnectDialogPage.render({ onConfirm }, { onOpenChange })

    await disconnectDialogPage.clickConfirm()

    expect(onConfirm).toHaveBeenCalledTimes(1)
    // Closing is the owner's call, and only once the server has answered — a
    // dialog that dismissed itself on the press would imply success it hasn't
    // been told about.
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('offers the press with nothing else to read', () => {
    disconnectDialogPage.render()

    expect(disconnectDialogPage.getConfirmButton()).toBeEnabled()
    // The live region exists from first paint — that is what makes anything
    // landing in it get announced — but says nothing yet.
    expect(disconnectDialogPage.getConfirmNote()).toBeEmptyDOMElement()
  })

  it('says the disconnect is under way, and refuses a second press meanwhile', () => {
    disconnectDialogPage.render({ isPending: true })

    expect(disconnectDialogPage.getConfirmNote()).toHaveTextContent(
      PENDING_NOTE,
    )
    expect(disconnectDialogPage.getConfirmButton()).toBeDisabled()
    // Leaving is always available, even mid-flight.
    expect(disconnectDialogPage.getDismissButton()).toBeEnabled()
  })

  it('says a refused disconnect changed nothing, and leaves the press available', () => {
    disconnectDialogPage.render({ isError: true })

    expect(disconnectDialogPage.getConfirmNote()).toHaveTextContent(
      FAILURE_NOTE,
    )
    expect(disconnectDialogPage.getConfirmNote()).toHaveClass(
      'fmm-claude__confirm-note--failed',
    )
    // Pressing again is the whole remedy, so the button must come back.
    expect(disconnectDialogPage.getConfirmButton()).toBeEnabled()
  })
})
