import { useId } from "react";
import { Heading } from "./heading";
import { type ScoreboardView } from "./scoreboard-query";

export interface ScoreboardDisplayProps {
  scoreboard: ScoreboardView;
  children: (scoreboard: ScoreboardView) => React.ReactNode;
}

export const ScoreboardDisplay = ({
  scoreboard,
  children,
}: ScoreboardDisplayProps) => {
  const id = useId();

  return (
    <section className="md-hero" aria-labelledby={id}>
      <h2 id={id} className="sr-only">
        {scoreboard.outcome ?? "Match"}
      </h2>
      <div className="md-hero__grid-bg" aria-hidden="true" />
      <Heading heading={scoreboard.heading} />
      {children(scoreboard)}
    </section>
  );
};
