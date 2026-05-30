import { render, screen } from "@testing-library/react";
import { Meta, type MetaProps } from "./meta";

export const metaPage = {
    render(props: MetaProps) {
        render(<Meta {...props} />);
    },

    // The status badge text, e.g. "Live · Game 3", "Upcoming", "Final".
    get status() {
        return document.querySelector('[data-slot="badge"]')?.textContent?.trim() ?? null;
    },

    get format() {
        return screen.getByText(/SINGLES · BO\d+/).textContent;
    },

    get firstTo() {
        const element = screen.queryByText(/First to \d+/);
        if (element === null) return null;
        return Number.parseInt(element.textContent?.replace(/\D+/g, "") ?? "", 10);
    },
};
