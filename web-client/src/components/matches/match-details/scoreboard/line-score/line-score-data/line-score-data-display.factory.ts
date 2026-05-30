import type { LineScoreDataDisplayProps } from "./line-score-data-display";
import { lineSideFactory } from "./line-score-data-display/line.factory";

export const lineScoreDataDisplayFactory = (
    overrides: Partial<LineScoreDataDisplayProps["lineScoreData"]> = {},
): LineScoreDataDisplayProps => ({
    lineScoreData: {
        bestOf: 5,
        sides: [lineSideFactory(), lineSideFactory()],
        games: [],
        ...overrides,
    },
});
