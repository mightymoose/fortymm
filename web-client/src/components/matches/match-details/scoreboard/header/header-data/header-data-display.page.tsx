import { render } from "@testing-library/react";
import {
    MatchHeaderDataDisplay,
    type MatchHeaderDataDisplayProps,
} from "./header-data-display";
import { metaPage } from "./header-data-display/meta.page";
import { matchScorePage } from "./header-data-display/match-score.page";

export const matchHeaderDataDisplayPage = {
    render(props: MatchHeaderDataDisplayProps) {
        render(<MatchHeaderDataDisplay {...props} />);
    },

    // The display is pure composition, so it reuses the child page objects to
    // confirm each section received its data.
    meta: metaPage,
    score: matchScorePage,
};
