import { buildRatingRowView } from "./ratings-display/rating-row.factory";
import { buildRatingsView } from "./ratings-display.factory";
import { ratingsDisplayPage } from "./ratings-display.page";

describe("RatingsDisplay", () => {
  it("renders the card as a region named by its heading", () => {
    ratingsDisplayPage.render();

    expect(ratingsDisplayPage.getCard()).toBeInTheDocument();
    expect(ratingsDisplayPage.getTitle()).toHaveTextContent(
      "Result · rating change",
    );
  });

  it("renders one row per side in view order", () => {
    ratingsDisplayPage.render();

    // Wiring only: row content is pinned by the query and rating-row tests.
    expect(ratingsDisplayPage.getRow("rita.kovac")).toBeInTheDocument();
    expect(ratingsDisplayPage.getRow("leo.mertens")).toBeInTheDocument();
  });

  it("separates the rows with a single hairline divider", () => {
    ratingsDisplayPage.render();

    expect(ratingsDisplayPage.getDividers()).toHaveLength(1);
  });

  it("draws no divider for a single-row card", () => {
    ratingsDisplayPage.render({
      ratings: buildRatingsView({ rows: [buildRatingRowView()] }),
    });

    expect(ratingsDisplayPage.getDividers()).toHaveLength(0);
  });
});
