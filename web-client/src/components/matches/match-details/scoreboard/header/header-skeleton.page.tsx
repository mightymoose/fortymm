import { render, screen } from "@testing-library/react";
import { HeaderSkeleton } from "./header-skeleton";

export const headerSkeletonPage = {
    render() {
        render(<HeaderSkeleton />);
    },

    get isBusy() {
        return screen.getByTestId("header-skeleton").getAttribute("aria-busy") === "true";
    },

    // The score row mirrors the md-hero layout; its presence confirms the
    // MatchScore half of the skeleton rendered alongside the Meta strip.
    get hasScorePlaceholder() {
        return document.querySelector(".md-hero__row") !== null;
    },

    get placeholderCount() {
        return document.querySelectorAll('[data-slot="skeleton"]').length;
    },
};
