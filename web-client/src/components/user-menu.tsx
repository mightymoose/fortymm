import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, LogOut, Settings, UserPlus } from 'lucide-react'
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

  const user = !isError && data ? data.data.user : null
  const username = user ? user.username : 'Guest'
  const isGuest = !user?.email

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="app-shell__user-menu app-shell__user-menu--trigger"
          data-testid="user-menu"
          aria-label={`Signed in as ${username}`}
        >
          <span className="app-shell__user-avatar-wrap">
            <UserAvatar name={username} size={30} dim={isGuest} />
            {isGuest && (
              <span
                className="app-shell__user-menu-dot--pulse"
                aria-hidden="true"
                data-testid="user-menu-guest-dot"
              />
            )}
          </span>
          <div
            className="app-shell__user-name app-shell__user-name--truncate"
            title={username}
          >
            {username}
          </div>
          <span className="app-shell__user-menu-chev" aria-hidden="true">
            <ChevronDown size={14} />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        {isGuest && (
          <>
            <DropdownMenuItem asChild className="p-0 focus:bg-transparent">
              <Link
                to="/settings"
                hash="sec-email"
                className="app-shell__claim-account"
                data-testid="user-menu-claim-account"
              >
                <span className="app-shell__claim-account__icon">
                  <UserPlus size={16} />
                </span>
                <span className="app-shell__claim-account__body">
                  <span className="app-shell__claim-account__title">
                    Claim account
                  </span>
                  <span className="app-shell__claim-account__sub">
                    Save your matches and rating.
                  </span>
                </span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
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
