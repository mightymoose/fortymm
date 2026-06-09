import { render, screen, type Container } from "@/test/utilities";

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
});

export const scoreboardDisplayPage = {
  render(overrides: Partial<ScoreboardDisplayProps> = {}) {
    const props = buildScoreboardDisplayProps(overrides);
    render(<ScoreboardDisplay {...props} />);
  },
  ...scoped(screen),
};
