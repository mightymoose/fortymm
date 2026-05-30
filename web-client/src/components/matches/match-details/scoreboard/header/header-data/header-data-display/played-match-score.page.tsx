import { render, screen } from "@testing-library/react";
import { PlayedMatchScore, type PlayedMatchScoreProps } from "./played-match-score";
import { playerScorePage } from "../../../player-score.page";

export const playedMatchScorePage = {
    render(props: PlayedMatchScoreProps) {
        render(<PlayedMatchScore {...props} />);
    },

    forPlayer(username: string) {
        return playerScorePage.within(screen.getByLabelText(`${username} sets`));
    },
};
