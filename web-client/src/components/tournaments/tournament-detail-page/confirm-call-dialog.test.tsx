import { buildPlacementSummary } from './confirm-call-dialog.factory'
import { confirmCallDialogPage as page } from './confirm-call-dialog.page'

describe('ConfirmCallDialog', () => {
  it('prices a CALL: the live-tournament copy, the destination, and a consequence-stating confirm', () => {
    page.render({
      consequence: {
        variant: 'call',
        to: buildPlacementSummary({ tableLabel: 'T2', time: '10:30' }),
      },
    })

    const dialog = page.getDialog()
    expect(dialog).toHaveTextContent('Call this match?')
    expect(dialog).toHaveTextContent('This tournament is live')
    expect(dialog).toHaveTextContent('player.1 vs player.4')
    expect(dialog).toHaveTextContent('T2 at 10:30')
    // The confirm states the consequence — never a bare "OK".
    expect(page.getConfirmButton()).toHaveTextContent('Call the match')
    // A first call has cost nothing yet: no notified counter.
    expect(page.queryNotified()).not.toBeInTheDocument()
  })

  it('prices a MOVE of a told fixture: names what the players were told, where it goes, and what the calls have cost', () => {
    page.render({
      consequence: {
        variant: 'correction-move',
        told: buildPlacementSummary({ tableLabel: 'T1', time: '09:00' }),
        to: buildPlacementSummary({ tableLabel: 'T3', time: '11:15' }),
        notifiedCount: 2,
      },
    })

    const dialog = page.getDialog()
    expect(dialog).toHaveTextContent('Move a called match?')
    // The stronger copy names what the players were TOLD — the promise being broken.
    expect(dialog).toHaveTextContent('were told T1 at 09:00')
    expect(dialog).toHaveTextContent('Moving it to T3 at 11:15 sends both a correction')
    expect(page.queryNotified()).toHaveTextContent('notified 2× already')
    expect(page.getConfirmButton()).toHaveTextContent('Move and notify')
  })

  it('prices a CLEAR of a told fixture: cancel-specific copy — the match is off this table', () => {
    page.render({
      consequence: {
        variant: 'correction-cancel',
        told: buildPlacementSummary({ tableLabel: 'T1', time: '09:00' }),
        notifiedCount: 1,
      },
    })

    const dialog = page.getDialog()
    expect(dialog).toHaveTextContent('Cancel this call?')
    expect(dialog).toHaveTextContent('were told T1 at 09:00')
    expect(dialog).toHaveTextContent('the match is off this table')
    expect(page.queryNotified()).toHaveTextContent('notified 1× already')
    expect(page.getConfirmButton()).toHaveTextContent('Cancel the call')
  })

  it('reads a table-only placement without inventing a time', () => {
    page.render({
      consequence: {
        variant: 'call',
        to: buildPlacementSummary({ tableLabel: 'T4', time: null }),
      },
    })
    expect(page.getDialog()).toHaveTextContent('notified to play on T4.')
  })

  it('fires onConfirm from the confirm button and nothing from cancel but onCancel', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    page.render({ onConfirm, onCancel })

    page.confirm()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()

    page.cancel()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('renders nothing while closed, and is a focus-trapping alertdialog while open', () => {
    page.render({ open: false })
    expect(page.queryDialog()).not.toBeInTheDocument()

    page.render({})
    // Radix AlertDialog: role, and focus lands inside the dialog (the trap's anchor).
    expect(page.getDialog()).toHaveAttribute('role', 'alertdialog')
    expect(page.getDialog().contains(document.activeElement)).toBe(true)
  })
})
