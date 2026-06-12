import { GameGridRow } from "./game-grid/game-grid-row";
import { type GameGridView } from "../scoreboard-query";

export interface GameGridProps {
  gameGrid: GameGridView;
}

export const GameGrid = ({ gameGrid }: GameGridProps) => {
  return (
    <div className="md-games" data-testid="scoreboard-game-grid">
      <div
        className="md-games__grid"
        style={{ "--md-games-count": gameGrid.bestOf } as React.CSSProperties}
      >
        <div className="md-games__kicker">GAMES</div>
        {Array.from({ length: gameGrid.bestOf }, (_, i) => (
          <div key={`h-${i}`} className="md-games__col-label">
            G{i + 1}
          </div>
        ))}
        <div className="md-games__col-label">SETS</div>

        {gameGrid.rows.map((row, i) => (
          <GameGridRow
            key={i}
            row={row}
            rowSide={i === 0 ? "left" : "right"}
            matchId={gameGrid.matchId}
          />
        ))}
      </div>
    </div>
  );
};
