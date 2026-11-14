import { Icon } from './Icon.tsx'
import './Toast.css'

// The design system's toast (.fm-toast): brief word that something
// succeeded ("Match saved. Rating +12."), for success only, with at most one
// action (Undo) and a button to dismiss it. A status message: assistive
// technology reads it when it appears, without moving focus. Where and how
// long it shows is the screen's to decide; this is the toast itself.
export function Toast({
  message,
  action,
  onAction,
  onDismiss,
}: {
  message: string
  // The one action's label, and what it does.
  action?: string
  onAction?: () => void
  onDismiss?: () => void
}) {
  return (
    <div className="toast" role="status">
      <Icon name="check" />
      <span className="toast__message">{message}</span>
      {action !== undefined && (
        <button type="button" className="toast__action" onClick={onAction}>
          {action}
        </button>
      )}
      <button
        type="button"
        className="toast__dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <Icon name="x" size="sm" />
      </button>
    </div>
  )
}
