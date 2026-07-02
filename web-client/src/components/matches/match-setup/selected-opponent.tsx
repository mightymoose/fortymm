import { UserAvatar } from '@/components/ui/user-avatar'
import { playerRoleLabel } from '@/components/matches/opponent-picker/player-identity'

import type { Opponent } from './opponent'
import './match-setup.css'

export interface SelectedOpponentProps {
  opponent: Opponent
  onChange: () => void
}

/** The picked-opponent pill: avatar, name, rating/role label, and a Change
 * control to go back to the picker. */
export const SelectedOpponent = ({
  opponent,
  onChange,
}: SelectedOpponentProps) => {
  return (
    <div className="nm-selected">
      <UserAvatar name={opponent.name} size={48} />
      <div className="info">
        <div className="name">{opponent.name}</div>
        {/* Same secondary label the picker chips and search rows use: the
            rating when known, the generic label only for unrated players. */}
        <div className="rating">{playerRoleLabel(opponent)}</div>
      </div>
      <button type="button" className="change" onClick={onChange}>
        Change
      </button>
    </div>
  )
}
