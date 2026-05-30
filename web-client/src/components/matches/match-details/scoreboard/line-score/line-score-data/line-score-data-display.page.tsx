import { render } from "@testing-library/react";
import {
    LineScoreDataDisplay,
    type LineScoreDataDisplayProps,
} from "./line-score-data-display";
import { linePage } from "./line-score-data-display/line.page";
import { lineScoreGridPage } from "./line-score-data-display/line-score-grid.page";

export const lineScoreDataDisplayPage = {
    render(props: LineScoreDataDisplayProps) {
        render(<LineScoreDataDisplay {...props} />);
    },

    // The display is pure composition — the grid shell wrapping one row per
    // side — so it reuses the child page objects to confirm each part received
    // its data.
    grid: lineScoreGridPage,
    line: linePage,
};
