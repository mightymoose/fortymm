import userEvent from '@testing-library/user-event'

import { render, screen, within, type Container } from '@/test/utilities'
import { Dialog } from '@/components/ui/dialog'
import { DisconnectDialog, type DisconnectDialogProps } from './disconnect-dialog'
import { buildDisconnectDialogProps } from './disconnect-dialog.factory'

/** The destructive button's accessible name — the same words as the control
 * that opened the dialog, because the dialog restates the action rather than
 * renaming it. */
const CONFIRM_LABEL = 'Disconnect Claude'

/** The dismiss button's accessible name. */
const DISMISS_LABEL = 'Keep it connected'

const scoped = (container: Container) => {
  const dialog = () => container.getByRole('dialog')

  return {
    /** The dialog itself. Throws where it must be open. */
    getDialog: dialog,
    /** The same, awaited — Radix mounts the portal a tick after the press. */
    findDialog() {
      return container.findByRole('dialog')
    },
    /** The same, for asserting **absence**: closed, or never opened. */
    queryDialog() {
      return container.queryByRole('dialog')
    },
    /** The dialog's heading, which also supplies its accessible name. */
    getConfirmHeading() {
      return within(dialog()).getByRole('heading')
    },
    /**
     * The three points, as normalised sentences.
     *
     * Read as whole list items rather than by `getByText`, because each one is
     * deliberately broken across a `<strong>` — and the first one's emphasised
     * clause (*"and any other AI assistant signed in with this email"*) is the
     * part a text-fragment assertion would happily pass without.
     */
    getConfirmPoints() {
      return within(dialog())
        .getAllByRole('listitem')
        .map((item) => (item.textContent ?? '').replace(/\s+/g, ' ').trim())
    },
    /** Every control inside the dialog, in DOM (and so tab) order. */
    getDialogButtons() {
      return within(dialog()).getAllByRole('button')
    },
    /** The destructive button. */
    getConfirmButton() {
      return within(dialog()).getByRole('button', { name: CONFIRM_LABEL })
    },
    /** The dismiss button. */
    getDismissButton() {
      return within(dialog()).getByRole('button', { name: DISMISS_LABEL })
    },
    /** The live region inside the dialog: in flight, and refused. Present from
     * first paint and empty when idle. */
    getConfirmNote() {
      return within(dialog()).getByRole('status')
    },
    /** Press the destructive button. */
    async clickConfirm() {
      await userEvent.click(
        within(dialog()).getByRole('button', { name: CONFIRM_LABEL }),
      )
    },
    /** Press the dismiss button. */
    async clickDismiss() {
      await userEvent.click(
        within(dialog()).getByRole('button', { name: DISMISS_LABEL }),
      )
    },
  }
}

export interface DisconnectDialogHarness {
  /** Told what the dialog asks for: `false` from the dismiss button, from
   * Escape, and from an outside press. */
  onOpenChange?: (open: boolean) => void
}

/**
 * Test page-object for `DisconnectDialog`.
 *
 * The component is the dialog's *content*; the `Dialog` root that carries the
 * open state is supplied here. That is not the page object standing in for
 * production markup — the root is a context provider, and on the real page it
 * belongs to `DisconnectButton`, which owns the open state and the mutation.
 * The behaviours that need both halves (the focus trap, Escape, focus return,
 * the page behind going out of reach) are therefore asserted in
 * `disconnect-button.test.tsx`, against the real pair; this object is for what
 * the dialog **says** and which of its two controls does what.
 */
export const disconnectDialogPage = {
  render(
    overrides: Partial<DisconnectDialogProps> = {},
    { onOpenChange = () => {} }: DisconnectDialogHarness = {},
  ) {
    const props = buildDisconnectDialogProps(overrides)
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DisconnectDialog {...props} />
      </Dialog>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
