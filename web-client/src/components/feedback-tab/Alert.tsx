import type { ReactNode } from 'react'
import { Icon } from '../Icon.tsx'
import './Alert.css'

export type AlertTone = 'warning' | 'error'

// The design system's alert (.fm-alert): a problem with a fix. Its title is
// the problem, its body why, and its actions the fix (small buttons). A
// warning (a conflict to decide, --conflict) waits in the page; an error
// (something failed, --danger) is announced at once: role="alert".
export function Alert({
  tone,
  title,
  children,
  actions,
}: {
  tone: AlertTone
  title: string
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <div
      className={`alert alert--${tone}`}
      role={tone === 'error' ? 'alert' : undefined}
    >
      <Icon name={tone === 'error' ? 'circle-alert' : 'triangle-alert'} />
      <p className="alert__title">{title}</p>
      <p className="alert__body">{children}</p>
      {actions !== undefined && <div className="alert__actions">{actions}</div>}
    </div>
  )
}
