import type { ReactNode } from 'react'

// What an empty list says instead, styled by `.fm-empty` in styles/kit.css:
// what's happening in bold, then what happens next, then an action to take,
// if there is one.
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
    <div className="fm-empty">
      <b>{title}</b>
      <span>{children}</span>
      {action}
    </div>
  )
}
