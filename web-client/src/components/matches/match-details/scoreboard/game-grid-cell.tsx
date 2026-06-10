import { Link } from "@tanstack/react-router";

import { scoringEditRoute } from "@/api/matches";
import { cn } from "@/lib/utils";
import { type GameGridCellView } from "./scoreboard-query";

export interface GameGridCellProps {
  cell: GameGridCellView;
  gameNumber: number;
  rowSide: "left" | "right";
  matchId: string;
}

export const GameGridCell = ({
  cell,
  gameNumber,
  rowSide,
  matchId,
}: GameGridCellProps) => {
  const testId = `scoreboard-game-grid-cell-${rowSide}-${gameNumber}`;
  if (cell.kind === "unplayed") {
    return (
      <div
        className={cn(
          "md-games__cell md-games__cell--empty",
          cell.isLive && "md-games__cell--live",
        )}
        data-testid={testId}
      >
        —
      </div>
    );
  }
  const className = cn(
    "md-games__cell",
    cell.won ? "md-games__cell--win" : "md-games__cell--loss",
  );
  if (cell.editGameNumber !== null) {
    return (
      <Link
        {...scoringEditRoute(matchId, cell.editGameNumber)}
        className={className}
        data-testid={testId}
      >
        {cell.points}
      </Link>
    );
  }
  return (
    <div className={className} data-testid={testId}>
      {cell.points}
    </div>
  );
};
