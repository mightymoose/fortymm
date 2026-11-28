import { useQuery } from '@tanstack/react-query'
import { Avatar } from '../../design-system/Avatar.tsx'
import { whoamiQuery } from '../../device/whoami-query.ts'

// Who this device is, in the top bar: the avatar of its username, worked out from its key with
// no server (src/device/whoami.ts). Its initials are the first letters of the username's first
// two words (agile-meerkat-4b8z is AM), and its name is the whole username. At non-phone widths
// the whole username is shown beside it too (TopBar.css); assistive technology already hears it
// as the avatar's name, so the shown copy is hidden from it.
//
// Nothing is shown while the identity is being worked out, or if the device has none (no key, or
// the core failed to load). The username is provisional until the server confirms it, and for
// now nothing says so.
export function DeviceAvatar() {
  const whoami = useQuery(whoamiQuery)
  if (!whoami.data?.ok) return null

  const { username } = whoami.data.identity
  return (
    <span className="top-bar__account">
      <Avatar initials={initialsOf(username)} name={username} />
      <span className="top-bar__username" aria-hidden="true">
        {username}
      </span>
    </span>
  )
}

function initialsOf(username: string): string {
  return username
    .split('-')
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join('')
    .toUpperCase()
}
