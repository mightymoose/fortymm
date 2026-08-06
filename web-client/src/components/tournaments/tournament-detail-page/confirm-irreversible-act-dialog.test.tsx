import {
  buildDeleteDrawConsequence,
  buildRecutDrawConsequence,
} from './confirm-irreversible-act-dialog.factory'
import { confirmIrreversibleActDialogPage as page } from './confirm-irreversible-act-dialog.page'

describe('ConfirmIrreversibleActDialog', () => {
  it('prices a RE-CUT: a completely new set of pairings, the named event, and the schedule that goes with them', () => {
    page.render({
      consequence: buildRecutDrawConsequence({ eventName: 'Womens Doubles' }),
    })

    const dialog = page.getDialog()
    expect(dialog).toHaveTextContent('Re-cut this draw?')
    // The event is named: the Events tab shows one card per event, so "the draw" alone
    // would be ambiguous the moment a director runs more than one.
    expect(dialog).toHaveTextContent('Re-cutting Womens Doubles')
    // Copy unique to THIS act — a re-cut replaces, it does not remove.
    expect(dialog).toHaveTextContent('deals a completely new set of pairings')
    expect(dialog).toHaveTextContent(
      'The pairings standing now are discarded, and so is any schedule built on them.',
    )
    // The confirm carries the act's own verb — never a bare "OK".
    expect(page.getConfirmButton()).toHaveTextContent('Re-cut the draw')
    expect(page.getCancelButton()).toHaveTextContent('Go back')
  })

  it('prices a DELETE: the draw and every fixture in it, the solved schedule included', () => {
    page.render({
      consequence: buildDeleteDrawConsequence({ eventName: 'Under 15s' }),
    })

    const dialog = page.getDialog()
    expect(dialog).toHaveTextContent('Delete this draw?')
    expect(dialog).toHaveTextContent('Deleting the draw for Under 15s')
    // Copy unique to THIS act — nothing replaces what is removed.
    expect(dialog).toHaveTextContent(
      'removes its pairings and every fixture in it, the solved schedule included',
    )
    expect(dialog).toHaveTextContent('Nothing is kept.')
    expect(page.getConfirmButton()).toHaveTextContent('Delete the draw')
  })

  it('neither variant borrows the other act’s sentence', () => {
    page.render({ consequence: buildRecutDrawConsequence() })
    expect(page.getDialog()).not.toHaveTextContent('Nothing is kept.')
    expect(page.getConfirmButton()).not.toHaveTextContent('Delete the draw')
  })

  it('reports the confirm ONCE and as no kind of cancel — Radix closes on the action click through the same channel Escape uses', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    page.render({ onConfirm, onCancel })

    page.confirm()

    expect(onConfirm).toHaveBeenCalledTimes(1)
    // The whole point: Radix reports the ACTION's close through onOpenChange(false),
    // the same call Escape and the overlay make. A confirm that also fired the cancel
    // path would destroy the draw AND tell the caller nothing happened.
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('reads Escape as the cancel, and sends no confirm with it', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    page.render({ onConfirm, onCancel })

    page.pressEscape()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('reads Go back as the cancel, and sends no confirm with it', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    page.render({ onConfirm, onCancel })

    page.cancel()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('consumes the confirm per close: a dialog re-opened after confirming still cancels on Escape', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    page.render({ onConfirm, onCancel })

    page.confirm()
    expect(onCancel).not.toHaveBeenCalled()

    // The parent kept it mounted. The remembered confirm must NOT swallow the next
    // dismiss, or a director's second thoughts read as a second confirm.
    page.pressEscape()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('under the production wiring, confirming dismisses the dialog and still reports no cancel', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    page.renderControlled({ onConfirm, onCancel })

    page.confirm()

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(page.queryDialog()).not.toBeInTheDocument()
    // The dismiss the parent performs must not come back as a cancel either.
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('renders nothing while closed, and is a focus-trapping alertdialog while open', () => {
    page.render({ open: false })
    expect(page.queryDialog()).not.toBeInTheDocument()

    page.render({})
    expect(page.getDialog()).toHaveAttribute('role', 'alertdialog')
    expect(page.getDialog().contains(document.activeElement)).toBe(true)
  })
})
