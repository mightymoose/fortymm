import { useId, type ReactNode } from 'react'

export type ToastVariant = 'info' | 'success' | 'error'

export type ToastAction = { label: string; onClick: () => void }

const variantClasses: Record<ToastVariant, string> = {
  info: 'toast--info',
  success: 'toast--success',
  error: 'toast--error',
}

// A short notice about something that just happened, as sonner shows them:
// a title over a description, an optional action button, and a close
// button. Styled by `.toast` in styles/base.css. It's a status, named by its
// title. The title is an h4, as the toast sits in a component card.
//
// It's shown in place, with no stacking, timer or position on the screen.
// The caller removes it on `onDismiss`, which the action also calls after
// its own `onClick`, as sonner closes a toast when its action is taken. The
// close button's name includes the title, so each toast's is unique.
export function Toast({
  variant,
  title,
  description,
  action,
  onDismiss,
}: {
  variant: ToastVariant
  title: string
  description: ReactNode
  action?: ToastAction
  onDismiss: () => void
}) {
  const titleId = useId()
  return (
    <div
      role="status"
      aria-labelledby={titleId}
      className={`toast ${variantClasses[variant]}`}
    >
      <div className="toast-body">
        <h4 id={titleId} className="toast-title">
          {title}
        </h4>
        <p className="toast-description">{description}</p>
      </div>
      {action && (
        <div className="toast-actions">
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              action.onClick()
              onDismiss()
            }}
          >
            {action.label}
          </button>
        </div>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label={`Dismiss "${title}"`}
        onClick={onDismiss}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2 2 L10 10 M10 2 L2 10" />
        </svg>
      </button>
    </div>
  )
}
