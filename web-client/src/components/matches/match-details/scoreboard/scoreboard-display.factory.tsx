import { buildScoreboardHeadingView } from "./heading.factory";
import type { ScoreboardView } from "./scoreboard-query";
import type { ScoreboardDisplayProps } from "./scoreboard-display";

/** The projected `{ status, outcome, heading, gameGrid }` view the display renders around. */
export function buildScoreboardView(
  overrides: Partial<ScoreboardView> = {},
): ScoreboardView {
  return {
    status: "scheduled",
    outcome: null,
    heading: buildScoreboardHeadingView(),
    // Null by default so the view renders without a router — scored grid
    // cells may carry typed <Link>s; see `gameGridPage.render`.
    gameGrid: null,
    ...overrides,
  };
}

/**
 * Props for `ScoreboardDisplay`. The default `children` renders a recognizable
 * marker so tests can assert the render-prop's output lands inside the section;
 * override it with a `vi.fn()` to inspect the argument it receives.
 */
export function buildScoreboardDisplayProps(
  overrides: Partial<ScoreboardDisplayProps> = {},
): ScoreboardDisplayProps {
  return {
    scoreboard: buildScoreboardView({
      outcome: "rita.kovac leading, 2 games to 1",
    }),
    children: () => <div data-testid="scoreboard-children">scoreboard body</div>,
    ...overrides,
  };
}
