import { HeroPlayer } from "./hero-player";
import { HeroScore } from "./hero-score";
import { type HeroRowView } from "./scoreboard-query";

export interface HeroRowProps {
  heroRow: HeroRowView;
}

export const HeroRow = ({ heroRow }: HeroRowProps) => {
  return (
    <div className="md-hero__row">
      <HeroPlayer side={heroRow.left} pos="l" />
      <HeroScore score={heroRow.score} />
      <HeroPlayer side={heroRow.right} pos="r" />
    </div>
  );
};
