import { useSession } from '@/api/session'
import { UserAvatar } from '@/components/ui/user-avatar'

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
      </div>
    )
  }

  const username = !isError && data ? data.data.user.username : 'Guest'

  return (
    <div
      className="app-shell__user-menu"
      data-testid="user-menu"
      aria-label={`Signed in as ${username}`}
    >
      <UserAvatar name={username} size={30} />
      <div
        className="app-shell__user-name app-shell__user-name--truncate"
        title={username}
      >
        {username}
      </div>
    </div>
  )
}
