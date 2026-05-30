import { faker } from "@faker-js/faker";
import type { LineProps } from "./line";
import type { GameScore, HeaderSide } from "../line-score-data-query";

export const lineSideFactory = (overrides: Partial<HeaderSide> = {}): HeaderSide => ({
    id: faker.string.uuid(),
    username: faker.person.firstName(),
    ...overrides,
});

// A single game with explicit per-side points, for asserting the exact value
// that lands in each cell.
export const game = (side0Points: number, side1Points: number): GameScore[] => [
    { sideNumber: 0, points: side0Points },
    { sideNumber: 1, points: side1Points },
];

// A game won by `sideNumber`; the loser's points are noise the scoring logic
// ignores, so they're randomised to signal "don't care". Use when only the
// winner / games-won tally matters.
export const gameWonBy = (sideNumber: number): GameScore[] =>
    sideNumber === 0
        ? game(11, faker.number.int({ min: 0, max: 9 }))
        : game(faker.number.int({ min: 0, max: 9 }), 11);

export const lineFactory = (overrides: Partial<LineProps> = {}): LineProps => {
    const sides = overrides.sides ?? [lineSideFactory(), lineSideFactory()];
    return {
        bestOf: 5,
        sides,
        games: [],
        // Default to rendering the first side's row; callers pass `side` (a
        // reference to one of `sides`) to render the opposite row.
        side: sides[0],
        ...overrides,
    };
};
