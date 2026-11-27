import { type ReactNode } from 'react'
import { Button } from './Button.tsx'
import { Icon } from './Icon.tsx'

export type ToastTone = 'success' | 'info'

// A toast: a brief, raised message offering one action. Success confirms that something happened
// (usually with Undo); info tells the user something they may act on. With onDismiss it has a
// Dismiss button. Announced politely (role="status"). Place toasts in a fm-toast-region.
export function Toast({
  tone = 'success',
  children,
  actionLabel,
  onAction,
  onDismiss,
}: {
  tone?: ToastTone
  children: ReactNode
  actionLabel?: string
  onAction?: () => void
  onDismiss?: () => void
}) {
  return (
    <div className={tone === 'info' ? 'fm-toast fm-toast--info' : 'fm-toast'} role="status">
      <Icon name={tone === 'info' ? 'info' : 'check'} />
      <span className="fm-toast__msg">{children}</span>
      {actionLabel && (
        <Button size="sm" className="fm-toast__action" onPress={onAction}>
          {actionLabel}
        </Button>
      )}
      {onDismiss && (
        <Button size="sm" className="fm-toast__close" aria-label="Dismiss" onPress={onDismiss}>
          <Icon name="x" size="sm" />
        </Button>
      )}
    </div>
  )
}
