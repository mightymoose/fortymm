import { User } from "lucide-react";

/**
 * The right half of the panel when the match has no second player — a real
 * side row carrying no player, or no second side at all. Reads as "solo"
 * rather than implying someone is on the way.
 */
export const NoOpponentProfile = () => (
  <div className="md-profile">
    <div className="md-profile__identity">
      <div className="md-avatar md-avatar--ghost" aria-hidden="true">
        <User size={20} strokeWidth={1.75} />
      </div>
      <div className="md-profile__id-text">
        <div className="md-profile__name md-profile__name--ghost">
          No opponent
        </div>
      </div>
    </div>
    <div className="md-profile__empty">Solo match — no second player.</div>
  </div>
);
