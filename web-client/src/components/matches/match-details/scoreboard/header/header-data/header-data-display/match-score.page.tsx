import { render } from "@testing-library/react";
import { MatchScore, type MatchScoreProps } from "./match-score";
import { playedMatchScorePage } from "./played-match-score.page";
import { upcomingMatchScorePage } from "./upcoming-match-score.page";

export const matchScorePage = {
    render(props: MatchScoreProps) {
        render(<MatchScore {...props} />);
    },

    // MatchScore delegates rendering to the played / upcoming subcomponents, so
    // it reuses their page objects to read the rendered result.
    forPlayer: playedMatchScorePage.forPlayer,
    hasPlayer: upcomingMatchScorePage.hasPlayer,
    hasVersusLabel: () => upcomingMatchScorePage.hasVersusLabel,

    // Participant names in render order — [left, right] — so callers can assert
    // sides land on the expected side of the hero row.
    get playerOrder() {
        return Array.from(document.querySelectorAll(".md-hero__name")).map(
            (element) => element.textContent,
        );
    },
};
