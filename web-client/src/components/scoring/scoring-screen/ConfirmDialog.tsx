import { useEffect, useRef } from 'react'
import { Button } from '../../Button.tsx'
import { Dialog } from '../../Dialog.tsx'
import './ConfirmDialog.css'

// A question over the scoring screen on a dimmed backdrop, as the new match
// screen's DiscardChangesDialog: the design system's Dialog, with the safe
// answer first (focused when it opens) and the one that loses something in
// danger. Escape, or a press on the backdrop, is the safe answer: a stray
// dismiss never discards a score. The screen asks two questions with it,
// "Leave without saving?" and "Clear game N?".
export function ConfirmDialog({
  title,
  children,
  stayLabel,
  goLabel,
  onGo,
  onStay,
}: {
  title: string
  children: string
  stayLabel: string
  goLabel: string
  onGo: () => void
  onStay: () => void
}) {
  const stay = useRef<HTMLDivElement>(null)
  const stayNow = useRef(onStay)
  useEffect(() => {
    stayNow.current = onStay
  }, [onStay])

  // Once, when it opens: focus on the safe answer, and Escape gives it.
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
      className="confirm-dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget) onStay()
      }}
    >
      <Dialog
        title={title}
        actions={
          <>
            <div ref={stay} className="confirm-dialog__stay">
              <Button variant="secondary" onClick={onStay}>
                {stayLabel}
              </Button>
            </div>
            <Button variant="danger-solid" onClick={onGo}>
              {goLabel}
            </Button>
          </>
        }
      >
        {children}
      </Dialog>
    </div>
  )
}
