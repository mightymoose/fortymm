import { User } from 'lucide-react'

import { UserAvatar } from '@/components/ui/user-avatar'
import { cn } from '@/lib/utils'

export interface PlayerChipView {
  /** Display label for the side — players joined by ' & ', or 'No opponent'. Pre-computed by the row projector via sideLabel. */
  name: string
  /** True when the side is null or has no players: render the dashed ghost avatar instead of a UserAvatar, and italicise the name. */
  isEmpty: boolean
  /** True only when this side won the match — paints the name with the winner color. */
  isWinner: boolean
}

export interface PlayerChipProps {
  chip: PlayerChipView
}

export const PlayerChip = ({ chip }: PlayerChipProps) => {
  const { name, isEmpty, isWinner } = chip
  return (
    <div className="player">
      {isEmpty ? (
        <span className="player-avatar player-avatar--ghost" aria-hidden="true">
          <User size={15} strokeWidth={1.75} />
        </span>
      ) : (
        <UserAvatar name={name} size={26} />
      )}
      <span
        className={cn(
          'player-name',
          isEmpty && 'is-empty',
          isWinner && 'is-winner',
        )}
      >
        {name}
      </span>
    </div>
  )
}
