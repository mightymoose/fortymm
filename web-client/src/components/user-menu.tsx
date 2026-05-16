import { useState } from 'react'
import { useSession } from '@/api/session'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChangeUsernameDialog } from './change-username-dialog'

function getInitials(username: string): string {
  const cleaned = username.replace(/[._-]+/g, ' ').trim()
  const parts = cleaned.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '??'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

export function UserMenu() {
  const { data, isLoading, isError } = useSession()
  const [editing, setEditing] = useState(false)

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
  const initials = getInitials(username)
  const signedIn = !isError && !!data

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
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
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            disabled={!signedIn}
            onSelect={(e) => {
              e.preventDefault()
              setEditing(true)
            }}
          >
            Change username
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {signedIn && (
        <ChangeUsernameDialog
          open={editing}
          onOpenChange={setEditing}
          currentUsername={username}
        />
      )}
    </>
  )
}
