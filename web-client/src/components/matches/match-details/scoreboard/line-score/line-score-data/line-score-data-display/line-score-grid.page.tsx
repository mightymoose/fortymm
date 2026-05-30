import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { LineScoreGrid } from "./line-score-grid";

export const lineScoreGridPage = {
    render(props: ComponentProps<typeof LineScoreGrid>) {
        render(<LineScoreGrid {...props} />);
    },

    // The grouped grid the rows live in, exposed for assistive tech.
    get group() {
        return screen.queryByRole("group", { name: "Game scores" });
    },

    get hasKicker() {
        return screen.queryByText("GAMES") !== null;
    },

    // The per-game column headers in order — "G1", "G2", … when labelled, or
    // empty strings while the real game count is still unknown.
    get columnLabels() {
        return Array.from(document.querySelectorAll(".md-games__col-label")).map(
            (element) => element.textContent,
        );
    },
};
