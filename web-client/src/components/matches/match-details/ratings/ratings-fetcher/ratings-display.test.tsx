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
    // `asChild` must keep the landmark a <section>: an anonymous <div> would
    // drop the region role the heading names.
    expect(ratingsDisplayPage.getCard().tagName).toBe("SECTION");
  });

  it("wears the shared design-system card chrome, not the hand-rolled one", () => {
    ratingsDisplayPage.render();

    const card = ratingsDisplayPage.getCard();
    // The shared `Card` slotted its chrome onto our <section>: hairline ring,
    // not the `.md-card` border.
    expect(card).toHaveAttribute("data-slot", "card");
    expect(card).toHaveClass("bg-card", "rounded-xl", "ring-1");
    expect(ratingsDisplayPage.queryHeader()).toBeInTheDocument();
    expect(ratingsDisplayPage.queryContent()).toBeInTheDocument();
    // No `.md-card` container, and no `.md-card__hd` — the rule under the
    // title is gone with it.
    expect(ratingsDisplayPage.queryLegacyChrome()).toEqual([]);
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
