import type {
  CorrectionScorelineCell,
  CorrectionScorelineProps,
} from "./correction-scoreline";

/** One scoreline cell — a viewer-won game `11–8` by default. */
export function buildCorrectionScorelineCell(
  overrides: Partial<CorrectionScorelineCell> = {},
): CorrectionScorelineCell {
  return {
    gameNumber: 1,
    myPoints: "11",
    oppPoints: "8",
    myWin: true,
    invalid: false,
    ...overrides,
  };
}

/**
 * Props for `CorrectionScoreline` — a best-of-5 strip seeded from a decided
 * 3–0 board (games 1–3 filled, 4–5 empty), game 1 open. Mirrors the
 * correction surface's standing-result pre-fill.
 */
export function buildCorrectionScorelineProps(
  overrides: Partial<CorrectionScorelineProps> = {},
): CorrectionScorelineProps {
  return {
    cells: [
      buildCorrectionScorelineCell({ gameNumber: 1, myPoints: "11", oppPoints: "8" }),
      buildCorrectionScorelineCell({ gameNumber: 2, myPoints: "11", oppPoints: "6" }),
      buildCorrectionScorelineCell({ gameNumber: 3, myPoints: "11", oppPoints: "9" }),
      buildCorrectionScorelineCell({
        gameNumber: 4,
        myPoints: null,
        oppPoints: null,
        myWin: null,
      }),
      buildCorrectionScorelineCell({
        gameNumber: 5,
        myPoints: null,
        oppPoints: null,
        myWin: null,
      }),
    ],
    activeGameNumber: 1,
    onSelect: () => {},
    onClear: () => {},
    ...overrides,
  };
}
