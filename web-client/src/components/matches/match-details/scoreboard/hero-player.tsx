import { User } from "lucide-react";

import { cn } from "@/lib/utils";
import { type HeroSideView } from "./scoreboard-query";

export interface HeroPlayerProps {
  side: HeroSideView;
  /** Which end of the hero row this side anchors — picks the l/r alignment
   * variants. */
  pos: "l" | "r";
}

export const HeroPlayer = ({ side, pos }: HeroPlayerProps) => {
  return (
    <div className={`md-hero__player md-hero__player--${pos}`}>
      <div className="md-hero__player-row">
        {side.isGhost ? (
          <div
            className="md-avatar md-avatar--ghost md-hero__avatar-singles"
            aria-hidden="true"
          >
            <User size={26} strokeWidth={1.75} />
          </div>
        ) : (
          <div
            className={cn(
              "md-avatar md-hero__avatar-singles",
              side.won ? "md-avatar--win" : "md-avatar--loss",
            )}
          >
            {side.initials}
          </div>
        )}
        <div className={`md-hero__player-text--${pos}`}>
          <div
            className={cn(
              "md-hero__name",
              side.won && "md-hero__name--win",
              side.isGhost && "md-hero__name--ghost",
            )}
          >
            {side.name}
          </div>
        </div>
      </div>
    </div>
  );
};
