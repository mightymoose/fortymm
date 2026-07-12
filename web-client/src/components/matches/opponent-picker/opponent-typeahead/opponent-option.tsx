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
  /**
   * Whether this row carries the highlight — the keyboard/pointer cursor. It is
   * **not** a selection (#894): it styles the row and is published to assistive
   * tech by the *combobox*, via `aria-activedescendant` pointing at this `id`.
   */
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
 *
 * `aria-selected` is **absent**, not `false` — an option here is never *selected*
 * (#894). Picking one commits the opponent to the match-setup card above and
 * closes the listbox, so no row is ever both rendered and chosen; the only
 * in-list state is the `active` highlight, and publishing that as
 * `aria-selected` told screen readers an opponent had been chosen while the card
 * still said "solo match".
 *
 * Omitted rather than set to `false` because ARIA 1.2 made `undefined` the
 * default for `option` precisely so a listbox with no persistent selection need
 * not annotate every row: an explicit `false` is *announced* ("not selected"),
 * on all five results, every time you arrow through them. The highlight reaches
 * assistive tech through the combobox's `aria-activedescendant` instead.
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
      aria-selected={undefined}
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
