import { User } from "lucide-react";

import { cn } from "@/lib/utils";
import { GameGridCell } from "./game-grid-row/game-grid-cell";
import { type GameGridRowView } from "../../scoreboard-query";

export interface GameGridRowProps {
  row: GameGridRowView;
  rowSide: "left" | "right";
  matchId: string;
}

export const GameGridRow = ({ row, rowSide, matchId }: GameGridRowProps) => {
  return (
    <>
      <div className="md-games__player">
        {row.isGhost ? (
          <span
            className="md-avatar md-avatar--ghost"
            aria-hidden="true"
            data-testid={`scoreboard-game-grid-avatar-${rowSide}`}
          >
            <User size={14} strokeWidth={1.75} />
          </span>
        ) : (
          <span
            className={cn(
              "md-avatar",
              row.won ? "md-avatar--win" : "md-avatar--loss",
            )}
            data-testid={`scoreboard-game-grid-avatar-${rowSide}`}
          >
            {row.initials}
          </span>
        )}
        <span
          className="md-games__player-name"
          data-testid={`scoreboard-game-grid-player-${rowSide}`}
        >
          {row.name}
        </span>
      </div>
      {row.cells.map((cell, i) => (
        <GameGridCell
          key={i}
          cell={cell}
          gameNumber={i + 1}
          rowSide={rowSide}
          matchId={matchId}
        />
      ))}
      <div
        className={cn("md-games__total", row.won && "md-games__total--win")}
        data-testid={`scoreboard-game-grid-total-${rowSide}`}
      >
        {row.gamesWon}
      </div>
    </>
  );
};
