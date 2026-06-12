import { useId } from "react";
import { GameGrid } from "./scoreboard-display/game-grid";
import { Heading } from "./scoreboard-display/heading";
import { HeroRow } from "./scoreboard-display/hero-row";
import { type ScoreboardView } from "./scoreboard-query";

export interface ScoreboardDisplayProps {
  scoreboard: ScoreboardView;
}

export const ScoreboardDisplay = ({ scoreboard }: ScoreboardDisplayProps) => {
  const id = useId();

  return (
    <section className="md-hero" aria-labelledby={id}>
      <h2 id={id} className="sr-only">
        {scoreboard.outcome ?? "Match"}
      </h2>
      <div className="md-hero__grid-bg" aria-hidden="true" />
      <Heading heading={scoreboard.heading} />
      <HeroRow heroRow={scoreboard.heroRow} />
      {scoreboard.gameGrid && <GameGrid gameGrid={scoreboard.gameGrid} />}
    </section>
  );
};
