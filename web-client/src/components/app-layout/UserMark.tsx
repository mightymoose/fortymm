import { useUser } from '../../stores/user.ts'
import { UserMarkLink } from './user-mark/UserMarkLink.tsx'

// The top bar's user mark, connected to the user store (src/stores/user.ts):
// this device's username once the store has read one, else none. The layout
// is always mounted, so when a first launch finishes, in this tab or
// another, the mark appears with no reload.
export function UserMark() {
  const user = useUser()
  return (
    <UserMarkLink
      username={user.state === 'user' ? user.user.username : null}
    />
  )
}
