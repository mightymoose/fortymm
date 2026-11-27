import { type ReactNode } from 'react'
import { Icon, type IconName } from './Icon.tsx'

export type AlertTone = 'warning' | 'error'

// An alert: a problem and how to fix it (warning), or what failed and how to recover (error), with
// the actions that do it. An error is announced as soon as it appears (role="alert"). `icon`
// replaces the tone's own icon when a more specific one names the problem, e.g. wifi-off. A
// warning with a `label` is a group named by it, e.g. "Scheduling conflict", for a warning that is
// one part of a larger whole (a match's detail).
export function Alert({
  tone,
  icon,
  label,
  title,
  children,
  actions,
}: {
  tone: AlertTone
  icon?: IconName
  label?: string
  title: ReactNode
  children: ReactNode
  actions?: ReactNode
}) {
  const role = tone === 'error' ? 'alert' : label ? 'group' : undefined
  return (
    <div className={`fm-alert fm-alert--${tone}`} role={role} aria-label={label}>
      <Icon name={icon ?? (tone === 'error' ? 'circle-alert' : 'triangle-alert')} />
      <p className="fm-alert__title">{title}</p>
      <p className="fm-alert__body">{children}</p>
      {actions && <div className="fm-alert__actions">{actions}</div>}
    </div>
  )
}
