import type { Player } from '@/api/matches'
import { UserAvatar } from '@/components/ui/user-avatar'
import { cn } from '@/lib/utils'

import {
  displayPlayerName,
  playerAccessibleName,
  playerRoleLabel,
} from '../player-identity'

export interface OpponentOptionProps {
  /** DOM id, referenced by the combobox's `aria-activedescendant` when active. */
  id: string
  /** The player this option represents. */
  player: Player
  /** Whether this is the active (keyboard-highlighted) option. */
  active: boolean
  /** Select this player. */
  onPick: () => void
  /**
   * Make this the active option in response to *real* cursor movement — wired
   * to `mousemove`, not `mouseenter`, so a stationary cursor sitting over rows
   * that re-render beneath it doesn't fight arrow-key navigation (#132).
   */
  onHover: () => void
}

/**
 * A single `role="option"` row in the opponent typeahead listbox (#94). The
 * avatar is decorative so the accessible name is just "username, role" rather
 * than the initials read twice (#99); the visible text degrades gracefully for
 * empty / emoji-only usernames (#101).
 */
export const OpponentOption = ({
  id,
  player,
  active,
  onPick,
  onHover,
}: OpponentOptionProps) => {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={active}
      aria-label={playerAccessibleName(player)}
      className={cn('nm-item', active && 'active')}
      onMouseMove={onHover}
      onClick={onPick}
    >
      <UserAvatar name={player.username} size={36} decorative />
      <div className="body">
        <div className="n">{displayPlayerName(player.username)}</div>
        <div className="m">{playerRoleLabel(player)}</div>
      </div>
    </button>
  )
}
