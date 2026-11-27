import { type ReactNode } from 'react'
import { Icon } from './Icon.tsx'

export type AlertTone = 'warning' | 'error'

// An alert: a problem and how to fix it (warning), or what failed and how to recover (error), with
// the actions that do it. An error is announced as soon as it appears (role="alert").
export function Alert({
  tone,
  title,
  children,
  actions,
}: {
  tone: AlertTone
  title: ReactNode
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className={`fm-alert fm-alert--${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <Icon name={tone === 'error' ? 'circle-alert' : 'triangle-alert'} />
      <p className="fm-alert__title">{title}</p>
      <p className="fm-alert__body">{children}</p>
      {actions && <div className="fm-alert__actions">{actions}</div>}
    </div>
  )
}
