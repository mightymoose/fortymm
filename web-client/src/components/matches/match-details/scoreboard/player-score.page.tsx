import { render } from "@testing-library/react";
import { PlayerScore, type PlayerScoreProps } from "./player-score";

const read = (element: HTMLElement) => ({
    get score() {
        return Number.parseInt(element.textContent ?? "", 10);
    },

    get won() {
        return element.textContent?.includes(", winner") ?? false;
    },
});

export const playerScorePage = {
    render(props: PlayerScoreProps) {
        render(<PlayerScore {...props} />);
    },

    within(element: HTMLElement) {
        return read(element);
    },

    get score() {
        return read(document.body).score;
    },

    get won() {
        return read(document.body).won;
    },
};
