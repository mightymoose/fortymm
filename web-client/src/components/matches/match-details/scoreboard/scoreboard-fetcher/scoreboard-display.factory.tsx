import { buildHeroRowView } from "./scoreboard-display/hero-row.factory";
import { buildScoreboardHeadingView } from "./scoreboard-display/heading.factory";
import type { ScoreboardView } from "./scoreboard-query";
import type { ScoreboardDisplayProps } from "./scoreboard-display";

/** The projected `{ status, outcome, heading, heroRow, gameGrid }` view the display renders. */
export function buildScoreboardView(
  overrides: Partial<ScoreboardView> = {},
): ScoreboardView {
  return {
    status: "scheduled",
    outcome: null,
    heading: buildScoreboardHeadingView(),
    heroRow: buildHeroRowView(),
    // Null by default so the view renders without a router — scored grid
    // cells may carry typed <Link>s; see `gameGridPage.render`.
    gameGrid: null,
    // Multi-game by default; a best-of-1 view sets this false to hide the grid.
    showGameGrid: true,
    ...overrides,
  };
}

/** Props for `ScoreboardDisplay`. */
export function buildScoreboardDisplayProps(
  overrides: Partial<ScoreboardDisplayProps> = {},
): ScoreboardDisplayProps {
  return {
    scoreboard: buildScoreboardView({
      outcome: "rita.kovac leads by 2 games to 1",
    }),
    ...overrides,
  };
}
