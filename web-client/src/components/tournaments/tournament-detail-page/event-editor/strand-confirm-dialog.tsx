import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export interface StrandConfirmDialogProps {
  open: boolean
  /** How many placed, undecided matches this save would newly strand — flagged by
   * `newlyStrandedFixtures` (`../../data/reservation-strand`) against the pending
   * draft, and not already flagged against the currently-saved reservations. Always
   * at least 1 while `open` — the editor never opens this dialog over nothing. */
  strandedCount: number
  /** Of those, how many were already **called** (`pinnedAt` set) — a promise already
   * made to two players, not just a placement the solver may still move. */
  calledCount: number
  onConfirm: () => void
  onCancel: () => void
}

const Strong = ({ children }: { children: React.ReactNode }) => (
  <span className="font-semibold text-[color:var(--fg-1)]">{children}</span>
)

/**
 * The confirmation between a reservation edit and a save that would **newly strand**
 * an already-placed match (#1537) — a match whose table, or predicted time, no longer
 * matches the reservation it is scheduled against once this edit lands.
 *
 * States the fact plainly, never as a fault: a director may be placing a match off its
 * reservation on purpose (sanctioned), and the same flag also catches the accidental
 * strand this ticket exists to surface. So the copy names what will be true, not who
 * did what — and the save is **never blocked**: "Save anyway" sends the exact draft the
 * director already composed, unmodified (`event-editor.tsx`'s `performSave`
 * continuation), in every tournament status. Dismissing any other way (Escape, the
 * overlay, Cancel) reads as Cancel — the same dismiss-defaults-to-cancel shape
 * `DiscardEventEditsDialog` uses, one directory over.
 */
export const StrandConfirmDialog = ({
  open,
  strandedCount,
  calledCount,
  onConfirm,
  onCancel,
}: StrandConfirmDialogProps) => {
  const matchWord = strandedCount === 1 ? 'match' : 'matches'
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <AlertDialogContent data-testid="strand-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Save this change?</AlertDialogTitle>
          <AlertDialogDescription>
            This will leave <Strong>{strandedCount}</Strong> placed {matchWord} outside
            the reservation {strandedCount === 1 ? 'it is' : 'they are'} scheduled
            against — a table it no longer holds, a time outside its window, or both.
            {calledCount > 0 && (
              <>
                {' '}
                <Strong>{calledCount}</Strong>{' '}
                {calledCount === 1 ? 'of those has' : 'of those have'} already been
                called — the players were told a table and a time.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="strand-confirm-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid="strand-confirm-save" onClick={onConfirm}>
            Save anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
