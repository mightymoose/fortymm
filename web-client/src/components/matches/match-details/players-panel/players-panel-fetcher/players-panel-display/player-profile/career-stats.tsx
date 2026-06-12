import { cn } from "@/lib/utils";

import { type CareerStatsView } from "../../players-panel-query";

export interface CareerStatsProps {
  career: CareerStatsView;
}

export const CareerStats = ({ career }: CareerStatsProps) => (
  <div className="md-profile__career">
    <div>
      <div className="md-kicker">Career matches</div>
      <div className="md-profile__career-value">{career.matches}</div>
    </div>
    <div>
      <div className="md-kicker">Win rate</div>
      <div
        className={cn(
          "md-profile__career-value",
          career.highWinRate && "md-profile__career-value--good",
        )}
      >
        {career.winRateLabel ?? <span className="dim">—</span>}
      </div>
    </div>
  </div>
);
