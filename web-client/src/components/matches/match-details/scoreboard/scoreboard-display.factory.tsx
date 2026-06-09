import { buildScoreboardHeadingView } from "./heading.factory";
import type { ScoreboardView } from "./scoreboard-query";
import type { ScoreboardDisplayProps } from "./scoreboard-display";

/** The projected `{ status, outcome, heading }` view the display renders around. */
export function buildScoreboardView(
  overrides: Partial<ScoreboardView> = {},
): ScoreboardView {
  return {
    status: "scheduled",
    outcome: null,
    heading: buildScoreboardHeadingView(),
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
