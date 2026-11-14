import { useEffect } from 'react'
import { useUser, watchUser } from '../stores/user.ts'
import { SettingsScreen, SettingsScreenPending } from './SettingsScreen.tsx'

// /settings, connected to the user store (src/stores/user.ts): it watches
// this device's user while mounted, so the screen shows each change (a first
// launch finishing, in this tab or another) with no reload. The route's
// loader has read the user before this mounts; until it is read again after
// a change no page watched, the screen's pending view shows.
export function Settings() {
  const user = useUser()
  useEffect(() => watchUser(), [])
  return user.state === 'unread' ? (
    <SettingsScreenPending />
  ) : (
    <SettingsScreen account={user} />
  )
}
