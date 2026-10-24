import { useEffect, useRef, useState } from 'react'
import { Button, type ButtonSize } from '../../components/Button'

// How long a demo button stays busy, as in the reference gallery.
export const BUSY_MS = 1400

// A button that shows `busyLabel` for BUSY_MS after a click, as if it were
// saving, then calls `onDone`. Nothing is sent anywhere.
export function BusyDemoButton({
  variant,
  size,
  label,
  busyLabel,
  onDone,
}: {
  variant: 'primary' | 'secondary'
  size?: ButtonSize
  label: string
  busyLabel: string
  onDone?: () => void
}) {
  const [busy, setBusy] = useState(false)
  // A ref, so a new `onDone` on a re-render doesn't restart the wait.
  const done = useRef(onDone)
  useEffect(() => {
    done.current = onDone
  })

  useEffect(() => {
    if (!busy) return
    const id = setTimeout(() => {
      setBusy(false)
      done.current?.()
    }, BUSY_MS)
    return () => clearTimeout(id)
  }, [busy])

  return (
    <Button variant={variant} size={size} busy={busy} onClick={() => setBusy(true)}>
      {busy ? busyLabel : label}
    </Button>
  )
}
