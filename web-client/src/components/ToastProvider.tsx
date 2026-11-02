import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isTestMode } from '../testMode'
import { AnnounceContext } from './announceContext'
import { Toast } from './Toast'
import {
  ToastContext,
  type ShowToast,
  type ToastIcon,
} from './toastContext'

// How long a toast stays up while it isn't hovered or focused.
export const TOAST_MS = 6000

// The most toasts shown at once. A new one pushes out the oldest.
const MAX_TOASTS = 3

type LiveToast = {
  id: number
  message: string
  icon: ToastIcon
  undo?: () => void
}

// Gives the app useToast() and shows its toasts bottom centre, in the
// `.fm-toast-region` of styles/kit.css, as kit.js's FM.toast does. Each
// toast leaves after TOAST_MS, and waits while it's hovered or focused. In
// test mode toasts stay until dismissed, as the gallery's do. It also gives
// useAnnounce(), which reads a message out through the same polite region
// that announces an Undo.
export function ToastProvider({ children, pinned }: { children: ReactNode; pinned?: ReactNode }) {
  const [toasts, setToasts] = useState<LiveToast[]>([])
  const [announcement, setAnnouncement] = useState('')
  const lastId = useRef(0)
  const announceTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const showToast = useCallback<ShowToast>((message, { icon = 'check', undo } = {}) => {
    const id = ++lastId.current
    setToasts((shown) => [...shown.slice(-(MAX_TOASTS - 1)), { id, message, icon, undo }])
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((shown) => shown.filter((toast) => toast.id !== id))
  }, [])

  // Empties the live region first, so the same words are read again.
  const announce = useCallback((message: string) => {
    setAnnouncement('')
    clearTimeout(announceTimer.current)
    announceTimer.current = setTimeout(() => setAnnouncement(message), 40)
  }, [])

  useEffect(() => () => clearTimeout(announceTimer.current), [])

  return (
    <ToastContext value={showToast}>
      <AnnounceContext value={announce}>{children}</AnnounceContext>
      {/* On <body>, as kit.js puts them, so the gallery's `only` test mode
          keeps them on screen. */}
      {createPortal(
        <>
          <div
            className="fm-toast-region"
            role="status"
            aria-live="polite"
            aria-label="Notifications"
          >
            {toasts.map((toast) => (
              <TimedToast
                key={toast.id}
                toast={toast}
                dismiss={dismiss}
                announce={announce}
              />
            ))}
            {pinned}
          </div>
          <div className="fm-sr" aria-live="polite">
            {announcement}
          </div>
        </>,
        document.body,
      )}
    </ToastContext>
  )
}

function TimedToast({
  toast: { id, message, icon, undo },
  dismiss,
  announce,
}: {
  toast: LiveToast
  dismiss: (id: number) => void
  announce: (message: string) => void
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (hovered || focused || isTestMode()) return
    const timer = setTimeout(() => dismiss(id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [hovered, focused, id, dismiss])

  return (
    <Toast
      message={message}
      icon={icon}
      action={
        undo && {
          label: 'Undo',
          onClick: () => {
            undo()
            dismiss(id)
            announce('Undone')
          },
        }
      }
      onDismiss={() => dismiss(id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    />
  )
}
