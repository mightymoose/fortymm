import { type ReactNode } from 'react'
import { Button } from './Button.tsx'
import { Icon } from './Icon.tsx'

// A toast: a brief, raised confirmation that something happened, offering one action (usually
// Undo). Announced politely (role="status").
export function Toast({
  children,
  actionLabel,
  onAction,
}: {
  children: ReactNode
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="fm-toast" role="status">
      <Icon name="check" />
      <span className="fm-toast__msg">{children}</span>
      {actionLabel && (
        <Button size="sm" className="fm-toast__action" onPress={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  )
}
