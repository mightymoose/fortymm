import { cn } from '@/lib/utils'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface DisconnectDialogProps {
  /** Fired by the destructive button. The owner runs the mutation; this
   * component never knows whether it worked, only what it was told to say. */
  onConfirm: () => void
  /** The disconnect request is in flight. */
  isPending: boolean
  /** The last attempt came back anything other than 200. */
  isError: boolean
}

/** What the live region says while the request is in flight. */
const PENDING_NOTE = 'Disconnecting Claude…'

/** What it says when the request was refused. The dialog **stays open** on a
 * failure: closing it would leave the player looking at a connected card with
 * no idea their press did nothing, which is the one way a destructive action
 * must never fail. */
const FAILURE_NOTE =
  "We couldn't disconnect Claude. Nothing has changed — try again in a moment."

/**
 * The confirmation for the page's one destructive action.
 *
 * Rendered *inside* a `Dialog` root, which the owning control provides: the
 * root is the open-state context and the trigger's other half, not chrome, so
 * this file holds the dialog itself and nothing else.
 *
 * The three bullets are the whole point of the surface — a player is about to
 * cut off something they set up, and each line answers one of the questions
 * that stops them:
 *
 * 1. **Scope.** The revocation is recorded on the *user*, not on a connector,
 *    so it stops every AI assistant signed in with this email — Claude, Claude
 *    Code, anything else. Today only Claude can connect (Auth0 Dynamic Client
 *    Registration is off), but that is one config change away, and this is the
 *    destructive action's own copy: it must not promise a Claude-only scope it
 *    does not have. **Do not trim the scope clause.**
 * 2. **What survives.** Everything an agent logged is the player's own data and
 *    stays; disconnecting is not a delete.
 * 3. **The way back.** Deliberately "switch Claude access back on", *not* "set
 *    it up again with the same two fields": revocation is sticky, so redoing
 *    the connector steps gets a silent 401 and only the re-allow control clears
 *    it (see the disconnecting-an-agent ADR).
 *
 * Accessibility comes from Radix's `Dialog` rather than a hand-rolled trap:
 * `role="dialog"` + `aria-modal`, labelled by its own title, Tab looped inside
 * the content, Escape closes, focus restored to whatever opened it *after* the
 * subtree has gone (Radix defers the restore a tick, which is what makes it
 * survive the overlay unmounting while it still holds focus), and the rest of
 * the page `aria-hidden` and pointer-events-none while it is up.
 */
export function DisconnectDialog({
  onConfirm,
  isPending,
  isError,
}: DisconnectDialogProps) {
  return (
    <DialogContent
      className="fmm-claude__confirm"
      // Radix does not set this itself — it makes the page behind unreachable
      // by hiding it (`aria-hidden` on every sibling) rather than by declaring
      // the dialog modal. Both are worth having: the hiding is what actually
      // holds, and this is what a screen reader that reads the attribute is
      // told. It is only honest because the content really is modal — focus is
      // trapped, the rest of the page takes no pointer events, and Escape is
      // the way out.
      aria-modal="true"
      // Two choices, both named: an X in the corner would be a third control
      // saying the same thing as "Keep it connected", and on a destructive
      // dialog the dismiss should read as a decision, not as an escape hatch.
      showCloseButton={false}
    >
      <DialogHeader>
        <DialogTitle>Disconnect Claude?</DialogTitle>
      </DialogHeader>
      {/* `asChild`, so the list itself is the dialog's accessible description:
          the three points ARE the description, and a summarising sentence above
          them would only be a fourth thing to read. */}
      <DialogDescription asChild>
        <ul className="fmm-claude__confirm-list">
          <li className="fmm-claude__grant-item">
            <span className="ball-dot" aria-hidden="true" />
            <span>
              Claude —{' '}
              <strong>and any other AI assistant signed in with this email</strong>{' '}
              — stops being able to read or change anything on your account,
              immediately.
            </span>
          </li>
          <li className="fmm-claude__grant-item">
            <span className="ball-dot" aria-hidden="true" />
            <span>
              Matches, results and draws it logged stay on your account — yours
              to edit or delete.
            </span>
          </li>
          <li className="fmm-claude__grant-item">
            <span className="ball-dot" aria-hidden="true" />
            <span>You can switch Claude access back on whenever you like.</span>
          </li>
        </ul>
      </DialogDescription>
      {/* Present from first paint (empty when idle) so a screen reader is
          already watching it; `:empty` keeps it out of the layout. */}
      <p
        className={cn(
          'fmm-claude__confirm-note',
          isError && 'fmm-claude__confirm-note--failed',
        )}
        role="status"
      >
        {isPending ? PENDING_NOTE : isError ? FAILURE_NOTE : ''}
      </p>
      {/* The footer's own layout: side by side from `sm` up, stacked with the
          destructive choice on top below it — the same rhythm as every other
          confirmation in the app. */}
      <DialogFooter>
        <DialogClose asChild>
          {/* Never disabled, not even mid-flight: a player must always be able
              to leave a dialog they opened. */}
          <button type="button" className="fmm-claude__action">
            Keep it connected
          </button>
        </DialogClose>
        <button
          type="button"
          className="fmm-claude__action fmm-claude__action--danger"
          // Only while the request is in flight. A refusal re-enables it,
          // because pressing again is the entire remedy.
          disabled={isPending}
          onClick={onConfirm}
        >
          Disconnect Claude
        </button>
      </DialogFooter>
    </DialogContent>
  )
}
