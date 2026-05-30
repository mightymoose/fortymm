import { render, screen } from "@testing-library/react";
import { Line, type LineProps } from "./line";
import { playerScorePage } from "../../../player-score.page";

// The participant name element for a given player (the avatar + name live in
// `.md-games__player`; the name is its `.md-games__player-name` span). A row
// renders exactly one, but the display stacks several, so reads are keyed by
// username to stay valid once composed.
const playerNameEl = (username: string) =>
    Array.from(document.querySelectorAll(".md-games__player-name")).find(
        (element) => element.textContent === username,
    ) ?? null;

// One game cell for a player, read through the PlayerScore page object. A played
// game is a labelled PlayerScore ("<username>, game <n>"); a not-yet-played slot
// renders an unlabelled em-dash cell, so `exists` is false for it.
const gameReader = (username: string, gameNumber: number) => {
    const element = screen.queryByLabelText(`${username}, game ${gameNumber}`);
    return {
        get exists() {
            return element !== null;
        },
        get score() {
            return element === null ? null : playerScorePage.within(element).score;
        },
        get won() {
            return element === null ? false : playerScorePage.within(element).won;
        },
    };
};

// All reads scoped to a single participant's row.
const userReader = (username: string) => ({
    // Whether this participant's row rendered at all.
    get exists() {
        return playerNameEl(username) !== null;
    },
    // True once this side has clinched the match — the winner treatment is
    // driven by `data-won` on the participant name.
    get won() {
        return playerNameEl(username)?.getAttribute("data-won") === "true";
    },
    game(gameNumber: number) {
        return gameReader(username, gameNumber);
    },
});

export const linePage = {
    render(props: LineProps) {
        render(<Line {...props} />);
    },

    // Scope reads to one participant, e.g. linePage.forUser("Ada").won,
    // .game(1).won, .game(1).exists, .game(1).score.
    forUser(username: string) {
        return userReader(username);
    },

    // Cells with no score yet render an em dash placeholder.
    get emptyCellCount() {
        return document.querySelectorAll(".md-games__cell--empty").length;
    },

    // Every cell — played or empty — carries `.md-games__cell`, so this is the
    // padded-to-best-of column count.
    get cellCount() {
        return document.querySelectorAll(".md-games__cell").length;
    },
};
