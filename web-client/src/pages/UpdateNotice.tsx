import { Toast } from '../components/Toast'
import { useUpdatePhase, type AppUpdate } from '../serviceWorker'

export function UpdateNotice({ appUpdate }: { appUpdate: AppUpdate }) {
  const phase = useUpdatePhase(appUpdate)
  if (phase === 'none' || phase === 'dismissed') return null
  const reloading = phase === 'reloading'
  return (
    <Toast
      icon="info"
      message="FortyMM has been updated."
      action={{ label: reloading ? 'Reloading…' : 'Reload', onClick: appUpdate.reload }}
      onDismiss={reloading ? undefined : appUpdate.dismiss}
    />
  )
}
