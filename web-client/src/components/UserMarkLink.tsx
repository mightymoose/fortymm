import { Link } from '@tanstack/react-router'
import { initials } from '../initials.ts'
import { Avatar } from './Avatar.tsx'
import './UserMarkLink.css'

// This device's user in the top bar: their initials in the design system's
// avatar and, at non-phone widths, the full username beside it (the
// layout's breakpoint hides it on phones); one link to /settings. Named
// with the full username, so a screen reader says the name once: the
// avatar and the visible name are hidden from it. With no username, or one
// with no initials, nothing.
export function UserMarkLink({ username }: { username: string | null }) {
  if (username === null || initials(username) === '') return null
  return (
    <Link to="/settings" className="user-mark" aria-label={username}>
      <Avatar initials={initials(username)} />
      <span className="user-mark__name" aria-hidden="true">
        {username}
      </span>
    </Link>
  )
}
