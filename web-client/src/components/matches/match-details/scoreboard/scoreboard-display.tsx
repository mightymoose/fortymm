import { useId } from "react";
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
      {children(scoreboard)}
    </section>
  );
};
