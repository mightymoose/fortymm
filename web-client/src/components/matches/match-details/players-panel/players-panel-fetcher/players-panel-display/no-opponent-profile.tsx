import { User } from "lucide-react";

import { UNLISTED_OPPONENT_LABEL } from "@/components/matches/unlisted-opponent-label";

/**
 * The right half of the panel when the match has no second player — a real
 * side row carrying no player, or no second side at all. A solo match can
 * record a real opponent who is not on FortyMM, so the copy names an unlisted
 * opponent rather than claiming nobody was there (#1522).
 */
export const NoOpponentProfile = () => (
  <div className="md-profile">
    <div className="md-profile__identity">
      <div className="md-avatar md-avatar--ghost" aria-hidden="true">
        <User size={20} strokeWidth={1.75} />
      </div>
      <div className="md-profile__id-text">
        <div className="md-profile__name md-profile__name--ghost">
          {UNLISTED_OPPONENT_LABEL}
        </div>
      </div>
    </div>
    <div className="md-profile__empty">
      This player is not on FortyMM, or the match was played alone.
    </div>
  </div>
);
