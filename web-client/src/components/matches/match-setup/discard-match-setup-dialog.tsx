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

// The in-app leave confirmation shared by the two match-setup surfaces
// (/matches/new and the dashboard FirstMatchCard). Both hold the same kind of
// unsaved state — a picked opponent / changed format — so they share one
// dialog rather than hand-copying it (#75, #811). Driven by the router
// blocker's resolver: "Discard & leave" proceeds with the blocked navigation,
// "Keep editing" cancels it; browser refresh/close is handled separately by
// the blocker's enableBeforeUnload. Mirrors score-entry's `UnsavedScorePrompt`.
export function DiscardMatchSetupDialog({
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
        // Radix fires onOpenChange(false) on overlay click / Escape — treat
        // that as "stay" so a stray dismiss never discards the form.
        if (!next) onStay?.()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You've picked an opponent or changed the match settings. Leaving now
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
