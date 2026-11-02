import type { ComponentProps, ReactNode } from 'react'
import { Icon } from './Icon'
import type { ToastIcon } from './toastContext'

export type ToastAction = {
  label: string
  onClick: () => void
}

export function Toast({
  message,
  icon = 'check',
  action,
  onDismiss,
  className,
  ...props
}: ComponentProps<'div'> & {
  message: ReactNode
  icon?: ToastIcon
  action?: ToastAction
  onDismiss?: () => void
}) {
  const classes = ['fm-toast']
  if (icon !== 'check') classes.push('fm-toast--info')
  if (className) classes.push(className)
  return (
    <div className={classes.join(' ')} {...props}>
      <Icon name={icon} />
      <span className="fm-toast__msg">{message}</span>
      {/* The toast's buttons take no variant: .fm-toast__action and
          .fm-toast__close set their colours. */}
      {action && (
        <button type="button" className="fm-btn fm-btn--sm fm-toast__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="fm-btn fm-btn--sm fm-toast__close"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <Icon name="x" className="fm-ic--sm" />
        </button>
      )}
    </div>
  )
}
