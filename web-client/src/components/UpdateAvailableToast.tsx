import { Toast } from '../design-system/Toast.tsx'

// Tells the user a new version of the web client is ready, with a Reload that switches to it.
export function UpdateAvailableToast({
  onReload,
  onDismiss,
}: {
  onReload: () => void
  onDismiss: () => void
}) {
  return (
    <div className="fm-toast-region">
      <Toast tone="info" actionLabel="Reload" onAction={onReload} onDismiss={onDismiss}>
        A new version of FortyMM is available.
      </Toast>
    </div>
  )
}
