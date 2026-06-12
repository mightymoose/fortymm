import { cn } from "@/lib/utils";
import { type HeroScoreView } from "../../scoreboard-query";

export interface HeroScoreProps {
  score: HeroScoreView;
}

export const HeroScore = ({ score }: HeroScoreProps) => {
  return (
    <div className="md-hero__score-block">
      {score.kind === "upcoming" ? (
        <>
          <div className="md-hero__vs-label">VS</div>
          <div className="md-hero__vs-dash">—</div>
          <div className="md-hero__vs-label">{score.statusLabel}</div>
        </>
      ) : (
        <div className="md-hero__score-row">
          <div
            className={cn(
              "md-hero__score md-hero__score--l",
              score.left.won && "md-hero__score--win",
            )}
          >
            {score.left.gamesWon}
          </div>
          <div className="md-hero__score-dash">—</div>
          <div
            className={cn(
              "md-hero__score md-hero__score--r",
              score.right.won && "md-hero__score--win",
            )}
          >
            {score.right.gamesWon}
          </div>
        </div>
      )}
    </div>
  );
};
