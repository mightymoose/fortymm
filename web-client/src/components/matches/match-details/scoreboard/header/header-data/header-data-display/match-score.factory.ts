import { faker } from "@faker-js/faker";
import type { MatchScoreProps } from "./match-score";
import type { UpcomingMatchScoreProps } from "./upcoming-match-score";
import type { GameScore, HeaderSide } from "../header-data-query";

export const headerSideFactory = (overrides: Partial<HeaderSide> = {}): HeaderSide => ({
    id: faker.string.uuid(),
    username: faker.person.firstName(),
    ...overrides,
});

// A single game whose winner is `sideNumber`; the loser's points are noise the
// scoring logic ignores, so they're randomised to signal "don't care".
export const gameWonBy = (sideNumber: number): GameScore[] => [
    { sideNumber: 0, points: sideNumber === 0 ? 11 : faker.number.int({ min: 0, max: 9 }) },
    { sideNumber: 1, points: sideNumber === 1 ? 11 : faker.number.int({ min: 0, max: 9 }) },
];

export const matchScoreFactory = (overrides: Partial<MatchScoreProps> = {}): MatchScoreProps => ({
    sides: [headerSideFactory(), headerSideFactory()],
    games: [],
    bestOf: 5,
    ...overrides,
});

export const upcomingMatchScoreFactory = (
    overrides: Partial<UpcomingMatchScoreProps> = {},
): UpcomingMatchScoreProps => ({
    sides: [headerSideFactory(), headerSideFactory()],
    ...overrides,
});
