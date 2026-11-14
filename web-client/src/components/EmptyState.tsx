import type { ReactNode } from 'react'
import './EmptyState.css'

// The design system's empty state (.fm-empty): what a list or page shows
// with nothing in it yet: what is missing ("No matches yet."), what to do
// about it, and the action that does it.
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <b>{title}</b>
      <span>{children}</span>
      {action}
    </div>
  )
}
