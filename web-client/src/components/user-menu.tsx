import { Link, useNavigate } from '@tanstack/react-router'
import { LogOut, Settings } from 'lucide-react'
import { useLogout, useSession } from '@/api/session'
import { UserAvatar } from '@/components/ui/user-avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function UserMenu() {
  const { data, isLoading, isError } = useSession()
  const logout = useLogout()
  const navigate = useNavigate()

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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="app-shell__user-menu app-shell__user-menu--trigger"
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
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          data-testid="user-menu-logout"
          onSelect={() => {
            logout.mutate(undefined, {
              onSuccess: () => {
                void navigate({ to: '/dashboard' })
              },
            })
          }}
        >
          <LogOut />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
