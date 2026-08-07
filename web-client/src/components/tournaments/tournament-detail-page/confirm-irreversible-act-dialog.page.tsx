import { useState } from 'react'

import { fireEvent, render, screen, type Container } from '@/test/utilities'

import {
  ConfirmIrreversibleActDialog,
  type ConfirmIrreversibleActDialogProps,
} from './confirm-irreversible-act-dialog'
import { buildConfirmIrreversibleActDialogProps } from './confirm-irreversible-act-dialog.factory'

const scoped = (container: Container) => ({
  /** The dialog itself — absent while `open` is false, and while a controlled parent
   * has closed it. */
  queryDialog() {
    return container.queryByRole('alertdialog')
  },
  getDialog() {
    return container.getByRole('alertdialog')
  },
  /** The confirm — it carries the act's own verb (`Re-cut the draw` / `Delete the
   * draw`), never a bare "OK", so it cannot be found by a fixed name. */
  getConfirmButton() {
    return container.getByTestId('confirm-irreversible-act-confirm')
  },
  /** The explicit way out — `Go back`. */
  getCancelButton() {
    return container.getByTestId('confirm-irreversible-act-cancel')
  },
  confirm() {
    fireEvent.click(container.getByTestId('confirm-irreversible-act-confirm'))
  },
  cancel() {
    fireEvent.click(container.getByTestId('confirm-irreversible-act-cancel'))
  },
  /** Escape, fired at the dialog so it bubbles to Radix's dismiss listener. Radix
   * reports it through the same `onOpenChange(false)` the action click uses. */
  pressEscape() {
    fireEvent.keyDown(container.getByRole('alertdialog'), { key: 'Escape' })
  },
})

/**
 * Test page-object for `ConfirmIrreversibleActDialog`. The dialog portals to the body,
 * so the default `screen` scope reaches it.
 *
 * Two harnesses, and the difference matters. `render` pins `open` from the props, so the
 * dialog stays mounted through a click — which is what lets a test count the callbacks a
 * single close produced. `renderControlled` gives `open` to a parent that closes on
 * either outcome, which is the production wiring and the only way to assert that
 * confirming dismisses the dialog *and* still reports no cancel.
 */
export const confirmIrreversibleActDialogPage = {
  render(overrides: Partial<ConfirmIrreversibleActDialogProps> = {}) {
    render(
      <ConfirmIrreversibleActDialog
        {...buildConfirmIrreversibleActDialogProps(overrides)}
      />,
    )
  },

  /** Mounts the dialog under a parent that owns `open` and closes it on either
   * outcome — the production wiring, where confirming both fires the act and
   * dismisses the dialog. */
  renderControlled(overrides: Partial<ConfirmIrreversibleActDialogProps> = {}) {
    const props = buildConfirmIrreversibleActDialogProps(overrides)
    const Harness = () => {
      const [open, setOpen] = useState(props.open)
      return (
        <ConfirmIrreversibleActDialog
          {...props}
          open={open}
          onConfirm={() => {
            setOpen(false)
            props.onConfirm()
          }}
          onCancel={() => {
            setOpen(false)
            props.onCancel()
          }}
        />
      )
    }
    render(<Harness />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
