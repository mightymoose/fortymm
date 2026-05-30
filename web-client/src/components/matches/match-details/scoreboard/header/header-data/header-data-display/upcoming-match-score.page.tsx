import { render, screen } from "@testing-library/react";
import { UpcomingMatchScore, type UpcomingMatchScoreProps } from "./upcoming-match-score";

export const upcomingMatchScorePage = {
    render(props: UpcomingMatchScoreProps) {
        render(<UpcomingMatchScore {...props} />);
    },

    get hasVersusLabel() {
        return screen.queryByText("VS") !== null;
    },

    hasPlayer(username: string) {
        return screen.queryByText(username) !== null;
    },

    scoreFor(username: string) {
        return screen.queryByLabelText(`${username} sets`);
    },
};
