import { TriangleAlert, X as XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** One cell of the correction scoreline strip — a single game's buffered score
 * in viewer orientation (my points left). Points are the raw input strings (or
 * null when that slot is empty), so a half-entered game still shows what's
 * typed. */
export interface CorrectionScorelineCell {
  gameNumber: number;
  myPoints: string | null;
  oppPoints: string | null;
  /** true = the viewer won this game, false = the opponent won, null = no
   * highlight (empty or not yet a legal, complete score). */
  myWin: boolean | null;
  /** Has input but isn't a legal, completed game (only one side filled, or an
   * illegal final score) — flagged so a disabled Send has a visible cause. */
  invalid: boolean;
}

export interface CorrectionScorelineProps {
  /** One entry per `best_of` slot, in game order; its length drives the strip
   * width (`--sl-cell-count`). */
  cells: CorrectionScorelineCell[];
  /** The game currently open in the pad above — rendered as the active cell. */
  activeGameNumber: number;
  /** Jump the pad to a game. */
  onSelect: (gameNumber: number) => void;
  /** Empty a game's buffered score (no confirmation — the buffer is local and
   * the standing result is untouched until Send). */
  onClear: (gameNumber: number) => void;
}

/**
 * The navigation strip below the correction pad — reproduces the scoring
 * page's SCORELINE look (the global `.scoreline`/`.sl-cells`/`.sl-cell` CSS)
 * but is purely presentational and buffer-backed: cells `onSelect` to switch
 * the open game (no route change) and the hover-✕ clears the buffered score
 * (no API, no dialog). Distinct from `score-entry`'s scratchpad-coupled
 * `Scoreline`, which navigates via `<Link>` and reads the save-mutation cache.
 */
export function CorrectionScoreline({
  cells,
  activeGameNumber,
  onSelect,
  onClear,
}: CorrectionScorelineProps) {
  return (
    <div className="scoreline">
      <div className="sl-label">SCORELINE</div>
      <div
        className="sl-cells"
        style={{ "--sl-cell-count": cells.length } as React.CSSProperties}
      >
        {cells.map((cell) => (
          <CorrectionScorelineCellView
            key={cell.gameNumber}
            cell={cell}
            isActive={cell.gameNumber === activeGameNumber}
            onSelect={onSelect}
            onClear={onClear}
          />
        ))}
      </div>
    </div>
  );
}

function CorrectionScorelineCellView({
  cell,
  isActive,
  onSelect,
  onClear,
}: {
  cell: CorrectionScorelineCell;
  isActive: boolean;
  onSelect: (gameNumber: number) => void;
  onClear: (gameNumber: number) => void;
}) {
  const isEmpty = cell.myPoints === null && cell.oppPoints === null;
  const cls = cn(
    "sl-cell",
    isActive
      ? "active"
      : cell.invalid
        ? "failed"
        : isEmpty
          ? "pending"
          : "done",
  );
  const ariaLabel = isEmpty
    ? `Go to game ${cell.gameNumber}, not yet entered`
    : `Go to game ${cell.gameNumber}, ${cell.myPoints ?? "—"} to ${cell.oppPoints ?? "—"}`;

  return (
    // A clickable cell (not a button) so the hover-✕ can nest a real <button>
    // without an invalid button-in-button — `aria-current="step"` marks the
    // open game for assistive tech.
    <div
      role="button"
      tabIndex={0}
      className={cls}
      aria-current={isActive ? "step" : undefined}
      aria-label={ariaLabel}
      onClick={() => onSelect(cell.gameNumber)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(cell.gameNumber);
        }
      }}
    >
      {cell.invalid && (
        <span className="sl-badge" aria-hidden>
          <TriangleAlert size={13} strokeWidth={2.25} />
        </span>
      )}
      <div className="sl-n">G{cell.gameNumber}</div>
      <div className="sl-scores">
        <span className={cn("s", cell.myWin === true && "w")}>
          {cell.myPoints ?? "—"}
        </span>
        <span className="dash">–</span>
        <span className={cn("s", cell.myWin === false && "w")}>
          {cell.oppPoints ?? "—"}
        </span>
      </div>
      {!isEmpty && (
        <button
          type="button"
          className="sl-clear"
          aria-label={`Clear game ${cell.gameNumber}`}
          title={`Clear game ${cell.gameNumber}`}
          onClick={(e) => {
            // Don't let the clear bubble up to the cell's select handler.
            e.stopPropagation();
            onClear(cell.gameNumber);
          }}
        >
          <XIcon size={14} strokeWidth={2.5} aria-hidden />
        </button>
      )}
    </div>
  );
}
