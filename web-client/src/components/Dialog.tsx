import { useId, type ReactNode } from 'react'

export type DialogVariant = 'dialog' | 'alert'

// Each variant's role and the classes that style it. An alert dialog asks
// to confirm something that can't be undone, so assistive tech announces it
// as urgent.
const variants: Record<
  DialogVariant,
  { role: 'dialog' | 'alertdialog'; className: string }
> = {
  dialog: { role: 'dialog', className: 'dialog' },
  alert: { role: 'alertdialog', className: 'dialog dialog--alert' },
}

// The surface of an open dialog, as in the WAI-ARIA dialog pattern: a `.dialog`
// named by its `.dialog-title` and described by its `.dialog-description`
// (styles/base.css), then the body (`children`) and a row of `actions`, e.g.
// buttons, at the bottom right. The title is an h4, as the dialog sits in a
// component card. It's shown in place, open. It doesn't open, close or trap the
// focus, so it takes no aria-modal.
export function Dialog({
  variant = 'dialog',
  title,
  description,
  actions,
  children,
}: {
  variant?: DialogVariant
  title: ReactNode
  description: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  const titleId = useId()
  const descriptionId = useId()
  const { role, className } = variants[variant]
  return (
    <div
      role={role}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={className}
    >
      <h4 id={titleId} className="dialog-title">
        {title}
      </h4>
      <p id={descriptionId} className="dialog-description">
        {description}
      </p>
      {children}
      {actions && <div className="dialog-actions">{actions}</div>}
    </div>
  )
}
