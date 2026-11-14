import type { ReactNode } from 'react'
import './Tag.css'

// The design system's tag (.fm-tag): a short fact about something (its
// event, a seeding), filled or, for a lesser one, outlined. Text, not a
// control.
export function Tag({
  outline = false,
  children,
}: {
  outline?: boolean
  children: ReactNode
}) {
  return (
    <span className={outline ? 'tag tag--outline' : 'tag'}>{children}</span>
  )
}
