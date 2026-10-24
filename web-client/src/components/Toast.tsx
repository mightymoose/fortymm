import type { ComponentProps, ReactNode } from 'react'
import { Icon } from './Icon'
import type { ToastIcon } from './toastContext'

// One toast, styled by `.fm-toast` in styles/kit.css: an icon, the message,
// Undo when `onUndo` is given, and Dismiss when `onDismiss` is. It only
// draws the toast.
// ToastProvider shows it in the toast region and times it out.
export function Toast({
  message,
  icon = 'check',
  onUndo,
  onDismiss,
  className,
  ...props
}: ComponentProps<'div'> & {
  message: ReactNode
  icon?: ToastIcon
  onUndo?: () => void
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
      {onUndo && (
        <button type="button" className="fm-btn fm-btn--sm fm-toast__action" onClick={onUndo}>
          Undo
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
