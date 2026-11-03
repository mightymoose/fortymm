import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../components/Button'
import { closeDialog } from '../../components/closeDialog'
import { Dialog } from '../../components/Dialog'
import { WriteError } from './WriteError'

// Asks before a change that can't be undone, open from when it mounts. Keep
// is the safe choice, first. `onConfirm` makes the change. The dialog closes
// once it succeeds, and says why if it fails. `onClose` unmounts it.
export function ConfirmDialog({
  title,
  confirmLabel,
  busyLabel,
  onConfirm,
  onClose,
  children,
}: {
  title: string
  confirmLabel: string
  // The confirm button's label while `onConfirm` runs, such as "Deleting…".
  busyLabel: string
  onConfirm: () => Promise<void>
  onClose: () => void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  async function confirm() {
    setBusy(true)
    setFailure(null)
    try {
      await onConfirm()
      dialog.current?.close()
    } catch (error) {
      setFailure(error)
      setBusy(false)
    }
  }

  return (
    <Dialog
      ref={dialog}
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={closeDialog} autoFocus>
            Keep
          </Button>
          <Button variant="danger-solid" busy={busy} disabled={busy} onClick={confirm}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {failure != null && <WriteError error={failure} />}
    </Dialog>
  )
}
