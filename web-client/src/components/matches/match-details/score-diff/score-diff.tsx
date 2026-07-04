import { cn } from "@/lib/utils";
import { Alert, AlertTitle } from "@/components/ui/alert";
import type { components } from "@/api/schema";

type NegotiationDiffEntry = components["schemas"]["NegotiationDiffEntry"];

export interface ScoreDiffProps {
  /**
   * The server-computed per-game diff (`negotiation.diff`). Each entry is a
   * game the correction added, removed, or changed relative to the viewer's
   * prior proposal; unchanged games are simply absent. We render the shape
   * as-is — no client-side diffing.
   */
  diff: NegotiationDiffEntry[];
}

/** Render a single game's points as "S1–S2". */
function formatGame(game: { side_1_points: number; side_2_points: number }) {
  return `${game.side_1_points}–${game.side_2_points}`;
}

/**
 * Presentational correction diff. For each entry it shows "Game N" with the old
 * score struck through and the new score emphasized. A correction may add,
 * remove, or change games (CONTEXT.md "Correction"): when `old` is null the
 * game was newly added (no strikethrough); when `new` is null the game was
 * removed (struck-through old, a "removed game" badge, no new score).
 */
export const ScoreDiff = ({ diff }: ScoreDiffProps) => {
  return (
    <Alert data-testid="score-diff">
      <AlertTitle>What changed</AlertTitle>
      <ul className="mt-1 grid gap-1.5">
        {diff.map((entry) => {
          const isAdded = entry.old === null;
          const isRemoved = entry.new === null;
          return (
            <li
              key={entry.game_number}
              data-testid={`score-diff-entry-${entry.game_number}`}
              className="flex items-baseline gap-2 text-sm"
            >
              <span className="w-14 shrink-0 font-medium tabular-nums text-muted-foreground">
                Game {entry.game_number}
              </span>
              {entry.old !== null && (
                <span
                  data-testid={`score-diff-old-${entry.game_number}`}
                  className="font-mono line-through text-[color:var(--loss)]"
                >
                  {formatGame(entry.old)}
                </span>
              )}
              <span
                aria-hidden
                className={cn(
                  "text-muted-foreground",
                  (isAdded || isRemoved) && "sr-only",
                )}
              >
                {"→"}
              </span>
              {entry.new !== null ? (
                <span
                  data-testid={`score-diff-new-${entry.game_number}`}
                  className="font-mono font-semibold text-[color:var(--win)]"
                >
                  {formatGame(entry.new)}
                  {isAdded && (
                    <span
                      data-testid={`score-diff-added-${entry.game_number}`}
                      className="ml-2 text-xs font-normal uppercase tracking-wide text-muted-foreground"
                    >
                      new game
                    </span>
                  )}
                </span>
              ) : (
                <span
                  data-testid={`score-diff-removed-${entry.game_number}`}
                  className="text-xs font-normal uppercase tracking-wide text-muted-foreground"
                >
                  removed game
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Alert>
  );
};
