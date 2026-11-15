import { useUser } from '../stores/user.ts'
import { SettingsScreen, SettingsScreenPending } from './settings/SettingsScreen.tsx'

// /settings, connected to the user store (src/stores/user.ts), which reads
// this device's user again on every change to it, so the screen shows each
// change (a first launch finishing, in this tab or another) with no reload.
// The route's loader has read the user before this mounts; the pending view
// is only for a store not read yet.
export function Settings() {
  const user = useUser()
  return user.state === 'unread' ? (
    <SettingsScreenPending />
  ) : (
    <SettingsScreen account={user} />
  )
}
