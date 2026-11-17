import { useId, type ReactNode } from 'react'
import { Icon } from './Icon.tsx'
import './Alert.css'

export type AlertTone = 'warning' | 'error'

// The design system's alert (.fm-alert): a problem with a fix. Its title is
// the problem, its body why, and its actions the fix (small buttons). A
// warning (a conflict to decide, --conflict) waits in the page; an error
// (something failed, --danger) is announced at once: role="alert", named
// by its title.
export function Alert({
  tone,
  title,
  children,
  actions,
  heading = false,
}: {
  tone: AlertTone
  title: string
  // The body; none when the title and the actions say it all.
  children?: ReactNode
  actions?: ReactNode
  // The title is the page's heading (an <h1>), for a page that is only
  // this alert: one title, not a heading and the same words again.
  heading?: boolean
}) {
  const titleId = useId()
  const Title = heading ? 'h1' : 'p'
  return (
    <div
      className={`alert alert--${tone}`}
      role={tone === 'error' ? 'alert' : undefined}
      aria-labelledby={tone === 'error' ? titleId : undefined}
    >
      <Icon name={tone === 'error' ? 'circle-alert' : 'triangle-alert'} />
      <Title id={titleId} className="alert__title">
        {title}
      </Title>
      {children !== undefined && <p className="alert__body">{children}</p>}
      {actions !== undefined && <div className="alert__actions">{actions}</div>}
    </div>
  )
}
