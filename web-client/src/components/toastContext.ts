import { createContext, useContext } from 'react'

// The icon a toast leads with: check for a confirmation, info for a note
// such as "isn't wired up in this demo".
export type ToastIcon = 'check' | 'info'

export type ToastOptions = {
  icon?: ToastIcon
  // Reverses the change the toast confirms. Pass it only when it really
  // does: the toast then offers Undo.
  undo?: () => void
}

// Raises a toast that confirms something the user just did.
export type ShowToast = (message: string, options?: ToastOptions) => void

export const ToastContext = createContext<ShowToast | null>(null)

// The ToastProvider's function for raising a toast.
export function useToast(): ShowToast {
  const showToast = useContext(ToastContext)
  if (!showToast) throw new Error('useToast() needs a ToastProvider above it')
  return showToast
}
