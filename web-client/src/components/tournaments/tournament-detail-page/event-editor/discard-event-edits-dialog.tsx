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

/**
 * "Discard changes?" — the confirmation that stands between an edited event and
 * every way of closing its editor (#1503).
 *
 * The editor is a URL now, so *one* thing closes it: a navigation that drops
 * `?event=`. Browser Back, Escape, an overlay click, the sheet's own close control
 * and Cancel all reach that same navigation, and the router's blocker is what puts
 * this dialog in front of it — so there is one guard rather than five, and no close
 * path can be added later that quietly misses it.
 *
 * Driven by the blocker's resolver, exactly as `DiscardMatchSetupDialog` is: **Discard
 * & leave** proceeds with the blocked navigation, **Keep editing** cancels it. On a
 * browser Back the pop has already committed by the time this renders, and cancelling
 * is what makes `@tanstack/history` put the entry back — which is why a second Back
 * press asks again instead of leaving the page with the sheet still open.
 *
 * A stray dismiss of the dialog itself (Escape, a click on its overlay) means **keep
 * editing**, never discard. The prompt exists to stop work being thrown away; a prompt
 * that throws it away when mis-dismissed would be worse than none.
 *
 * It is armed only while the form is dirty. A confirmation over nothing is the
 * confirmation people learn to click through.
 */
export function DiscardEventEditsDialog({
  open,
  onLeave,
  onStay,
}: {
  open: boolean
  onLeave?: () => void
  onStay?: () => void
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onStay?.()
      }}
    >
      <AlertDialogContent data-testid="discard-event-edits">
        <AlertDialogHeader>
          <AlertDialogTitle>Discard changes?</AlertDialogTitle>
          <AlertDialogDescription>
            This event has changes you haven't saved. Closing the editor now
            discards them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onStay}>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onLeave}>
            Discard &amp; leave
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
