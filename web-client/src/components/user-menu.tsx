import { useSession } from '@/api/session'

function getInitials(username: string): string {
  const cleaned = username.replace(/[._-]+/g, ' ').trim()
  const parts = cleaned.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '??'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

export function UserMenu() {
  const { data, isLoading, isError } = useSession()

  if (isLoading) {
    return (
      <div
        className="app-shell__user-menu app-shell__user-menu--loading"
        aria-busy="true"
        aria-label="Loading user menu"
        data-testid="user-menu-skeleton"
      >
        <div className="app-shell__user-avatar app-shell__skeleton app-shell__skeleton--avatar" />
        <div className="app-shell__user-name app-shell__skeleton app-shell__skeleton--name" />
        <span className="app-shell__user-chev" aria-hidden="true">
          <Chevron />
        </span>
      </div>
    )
  }

  const username = !isError && data ? data.data.user.username : 'Guest'
  const initials = getInitials(username)

  return (
    <button
      type="button"
      className="app-shell__user-menu"
      aria-label="User menu"
    >
      <div className="app-shell__user-avatar">{initials}</div>
      <div
        className="app-shell__user-name app-shell__user-name--truncate"
        title={username}
      >
        {username}
      </div>
      <span className="app-shell__user-chev" aria-hidden="true">
        <Chevron />
      </span>
    </button>
  )
}

function Chevron() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}
