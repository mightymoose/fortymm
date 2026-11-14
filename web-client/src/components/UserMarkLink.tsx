import { Link } from '@tanstack/react-router'
import { initials } from '../initials.ts'
import { Avatar } from './Avatar.tsx'
import './UserMarkLink.css'

// This device's user in the phone top bar: their initials in the design
// system's avatar, a link to /settings, where the username is shown. Named
// with the full username, so a screen reader says the name, not the
// initials (the avatar itself is hidden from it). With no username, or one
// with no initials, nothing.
export function UserMarkLink({ username }: { username: string | null }) {
  if (username === null || initials(username) === '') return null
  return (
    <Link to="/settings" className="user-mark" aria-label={username}>
      <Avatar initials={initials(username)} />
    </Link>
  )
}
