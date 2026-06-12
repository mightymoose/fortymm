import { Clock } from "lucide-react";

import { type ScoreboardHeadingView } from "../scoreboard-query";
import { StatusChip } from "./heading/status-chip";

export interface HeadingProps {
  heading: ScoreboardHeadingView;
}

export const Heading = ({ heading }: HeadingProps) => {
  return (
    <div className="md-hero__strip">
      <div className="md-hero__strip-l">
        {heading.chip && <StatusChip chip={heading.chip} />}
      </div>
      <div className="md-hero__strip-r">
        <span data-testid="scoreboard-heading-format" className="md-hero__strip-meta">
          {heading.formatLabel}
        </span>
        {heading.raceLabel && (
          <span
            data-testid="scoreboard-heading-race"
            className="md-hero__strip-meta md-hero__strip-meta--with-icon"
          >
            <Clock size={13} strokeWidth={1.75} />
            {heading.raceLabel}
          </span>
        )}
      </div>
    </div>
  );
};
