import { useEffect, useRef } from 'react'
import { Button } from '../../Button.tsx'
import { Dialog } from '../../Dialog.tsx'
import './DiscardChangesDialog.css'

// "Discard changes?" (fortymm-real's DiscardMatchSetupDialog), over the
// screen on a dimmed backdrop: the design system's Dialog, with Keep editing
// first (the safe answer, focused when it opens) and "Discard & leave".
// Escape, or a press on the backdrop, keeps editing: a stray dismiss never
// discards the form.
export function DiscardChangesDialog({
  onLeave,
  onStay,
}: {
  onLeave: () => void
  onStay: () => void
}) {
  const stay = useRef<HTMLDivElement>(null)
  const stayNow = useRef(onStay)
  useEffect(() => {
    stayNow.current = onStay
  }, [onStay])

  // Once, when it opens: focus on Keep editing, and Escape keeps editing.
  useEffect(() => {
    stay.current?.querySelector('button')?.focus()
    function keyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') stayNow.current()
    }
    document.addEventListener('keydown', keyDown)
    return () => document.removeEventListener('keydown', keyDown)
  }, [])

  return (
    <div
      role="presentation"
      className="discard-changes"
      onClick={(event) => {
        if (event.target === event.currentTarget) onStay()
      }}
    >
      <Dialog
        title="Discard changes?"
        actions={
          <>
            <div ref={stay} className="discard-changes__stay">
              <Button variant="secondary" onClick={onStay}>
                Keep editing
              </Button>
            </div>
            <Button variant="danger-solid" onClick={onLeave}>
              Discard &amp; leave
            </Button>
          </>
        }
      >
        You’ve named an opponent or changed the match settings. Leaving now
        discards them.
      </Dialog>
    </div>
  )
}
