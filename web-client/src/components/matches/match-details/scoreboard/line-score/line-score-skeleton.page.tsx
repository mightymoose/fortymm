import { render, screen } from "@testing-library/react";
import { LineScoreSkeleton } from "./line-score-skeleton";

export const lineScoreSkeletonPage = {
    render() {
        render(<LineScoreSkeleton />);
    },

    // The skeleton reuses the real grid shell, so the grouped grid being present
    // confirms it reserves the same columns the loaded line score will fill.
    get hasGridPlaceholder() {
        return screen.queryByRole("group", { name: "Game scores" }) !== null;
    },

    get placeholderCount() {
        return document.querySelectorAll('[data-slot="skeleton"]').length;
    },

    // One `.md-games__player` per skeleton row, so this is the reserved side
    // count.
    get rowCount() {
        return document.querySelectorAll(".md-games__player").length;
    },

    get columnLabels() {
        return Array.from(document.querySelectorAll(".md-games__col-label")).map(
            (element) => element.textContent,
        );
    },
};
