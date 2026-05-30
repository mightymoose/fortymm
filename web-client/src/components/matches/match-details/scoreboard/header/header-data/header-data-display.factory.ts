import type { MatchHeaderDataDisplayProps } from "./header-data-display";
import { headerSideFactory } from "./header-data-display/match-score.factory";

export const matchHeaderDataDisplayFactory = (
    overrides: Partial<MatchHeaderDataDisplayProps["matchHeaderData"]> = {},
): MatchHeaderDataDisplayProps => ({
    matchHeaderData: {
        status: { kind: "final" },
        bestOf: 5,
        sides: [headerSideFactory(), headerSideFactory()],
        games: [],
        ...overrides,
    },
});
