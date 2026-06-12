import { render, screen, type Container } from "@/test/utilities";

import { gameGridPage } from "./scoreboard-display/game-grid.page";
import { headingPage } from "./scoreboard-display/heading.page";
import { heroRowPage } from "./scoreboard-display/hero-row.page";
import {
  ScoreboardDisplay,
  type ScoreboardDisplayProps,
} from "./scoreboard-display";
import { buildScoreboardDisplayProps } from "./scoreboard-display.factory";

const scoped = (container: Container) => ({
  getHeading() {
    return container.getByRole("heading", { level: 2 });
  },
  getContainer() {
    return container.getByRole("region");
  },
  /** The heading strip (status chip + format/race labels) the display renders. */
  headingStrip: headingPage.within(container),
  /** The hero row (left player / score block / right player) in the middle. */
  heroRow: heroRowPage.within(container),
  /** The per-game score grid at the bottom; absent when `gameGrid` is null. */
  gameGrid: gameGridPage.within(container),
});

export const scoreboardDisplayPage = {
  render(overrides: Partial<ScoreboardDisplayProps> = {}) {
    const props = buildScoreboardDisplayProps(overrides);
    render(<ScoreboardDisplay {...props} />);
  },
  ...scoped(screen),
};
