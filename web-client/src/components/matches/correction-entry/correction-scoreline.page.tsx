import { render, screen, type Container } from "@/test/utilities";

import {
  CorrectionScoreline,
  type CorrectionScorelineProps,
} from "./correction-scoreline";
import { buildCorrectionScorelineProps } from "./correction-scoreline.factory";

const scoped = (container: Container) => ({
  /** A game's cell, by its accessible label (`"Go to game N, …"`). */
  getCell(gameNumber: number) {
    return container.getByRole("button", {
      name: new RegExp(`^go to game ${gameNumber}\\b`, "i"),
    });
  },
  /** The active cell (the open game) — there's exactly one. */
  getActiveCell() {
    return container.getByRole("button", { current: "step" });
  },
  /** A game's hover-✕ clear button. */
  getClear(gameNumber: number) {
    return container.getByRole("button", { name: `Clear game ${gameNumber}` });
  },
  /** Whether a game's clear ✕ is present (absent on empty slots). */
  queryClear(gameNumber: number) {
    return container.queryByRole("button", {
      name: `Clear game ${gameNumber}`,
    });
  },
});

/**
 * Test page-object for `CorrectionScoreline` — the presentational nav strip.
 * Pure, so `render` mounts it directly (no router/suspense harness).
 */
export const correctionScorelinePage = {
  render(overrides: Partial<CorrectionScorelineProps> = {}) {
    const props = buildCorrectionScorelineProps(overrides);
    render(<CorrectionScoreline {...props} />);
  },

  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
