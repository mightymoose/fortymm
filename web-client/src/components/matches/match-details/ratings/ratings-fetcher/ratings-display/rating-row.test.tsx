import { cleanup } from "@/test/utilities";

import {
  buildEstablishedRatingRowChangeView,
  buildRatingRowChangeView,
  buildRatingRowView,
} from "./rating-row.factory";
import { ratingRowPage } from "./rating-row.page";

describe("RatingRow", () => {
  it("tones the avatar as a win for the winning side", () => {
    ratingRowPage.render({
      row: buildRatingRowView({ initials: "RK", won: true }),
    });

    const avatar = ratingRowPage.getAvatar("rita.kovac");
    expect(avatar).toHaveTextContent("RK");
    expect(avatar).toHaveClass("md-avatar--win");
    expect(avatar).not.toHaveClass("md-avatar--loss");
  });

  it("tones the avatar as a loss for the losing side", () => {
    ratingRowPage.render({ row: buildRatingRowView({ won: false }) });

    expect(ratingRowPage.getAvatar("rita.kovac")).toHaveClass(
      "md-avatar--loss",
    );
  });

  it("shows the before and after numbers for a rated change", () => {
    ratingRowPage.render();

    expect(ratingRowPage.queryFrom("rita.kovac")).toHaveTextContent(/^1612$/);
    expect(ratingRowPage.queryTo("rita.kovac")).toHaveTextContent(/^1624$/);
  });

  it("reads a first rated match as 'Unrated → 1268' — the rating was established, not moved", () => {
    ratingRowPage.render({
      row: buildRatingRowView({
        change: buildEstablishedRatingRowChangeView({ to: 1268 }),
      }),
    });

    // The word, not a number: the 1500 their league-join seeded is a prior, not
    // a rating they held, so there is nothing to have fallen from (#952).
    expect(ratingRowPage.queryFrom("rita.kovac")).toHaveTextContent(
      /^Unrated$/,
    );
    expect(ratingRowPage.queryTo("rita.kovac")).toHaveTextContent(/^1268$/);
    expect(ratingRowPage.getNumbers("rita.kovac")).not.toHaveTextContent(
      "1500",
    );
  });

  it("shows no delta chip and no trend line for an established rating", () => {
    ratingRowPage.render({
      row: buildRatingRowView({
        change: buildEstablishedRatingRowChangeView(),
      }),
    });

    // Not a "+0", not a "−232", not a signed anything: nothing moved.
    expect(ratingRowPage.queryDelta("rita.kovac")).toBeNull();
    expect(ratingRowPage.sparkline("rita.kovac").querySparkline()).toBeNull();
    expect(ratingRowPage.getRow("rita.kovac")).not.toHaveTextContent(
      /[+−-]\s*\d/,
    );
  });

  it("names the established line for a screen reader, since the chevron is decorative", () => {
    ratingRowPage.render({
      row: buildRatingRowView({
        change: buildEstablishedRatingRowChangeView({
          to: 1268,
          ariaLabel: "Unrated before this match, now rated 1268",
        }),
      }),
    });

    expect(ratingRowPage.getNumbers("rita.kovac")).toHaveAccessibleName(
      "Unrated before this match, now rated 1268",
    );
  });

  it("keeps an established rating and no-rating-at-all visibly apart", () => {
    // Two different facts, two different renders — if a later 'simplification'
    // folded them together, one of these two assertions breaks.
    ratingRowPage.render({
      row: buildRatingRowView({
        change: buildEstablishedRatingRowChangeView({ to: 1268 }),
      }),
    });
    expect(ratingRowPage.getNumbers("rita.kovac")).toHaveTextContent(
      /^Unrated1268$/,
    );

    cleanup();

    ratingRowPage.render({ row: buildRatingRowView({ change: null }) });
    expect(ratingRowPage.getNumbers("rita.kovac")).toHaveTextContent(
      /^Unrated player$/,
    );
  });

  it("tones a positive delta up and shows its label", () => {
    ratingRowPage.render({
      row: buildRatingRowView({
        change: buildRatingRowChangeView({ deltaLabel: "+12", deltaUp: true }),
      }),
    });

    const delta = ratingRowPage.queryDelta("rita.kovac");
    expect(delta).toHaveTextContent(/^\+12$/);
    expect(delta).toHaveClass("md-delta-up");
    expect(delta).not.toHaveClass("md-delta-down");
  });

  it("labels the delta chip for screen readers so the sign isn't voiced as punctuation", () => {
    ratingRowPage.render({
      row: buildRatingRowView({
        change: buildRatingRowChangeView({
          deltaLabel: "+12",
          deltaAriaLabel: "Gained 12 rating",
        }),
      }),
    });

    expect(ratingRowPage.queryDelta("rita.kovac")).toHaveAttribute(
      "aria-label",
      "Gained 12 rating",
    );
  });

  it("tones a negative delta down", () => {
    ratingRowPage.render({
      row: buildRatingRowView({
        change: buildRatingRowChangeView({ deltaLabel: "-8", deltaUp: false }),
      }),
    });

    const delta = ratingRowPage.queryDelta("rita.kovac");
    expect(delta).toHaveTextContent(/^-8$/);
    expect(delta).toHaveClass("md-delta-down");
  });

  it("draws the trend sparkline when the view supplies a series", () => {
    ratingRowPage.render();

    expect(
      ratingRowPage.sparkline("rita.kovac").querySparkline(),
    ).toBeInTheDocument();
  });

  it("withholds the sparkline when the view has no series", () => {
    ratingRowPage.render({
      row: buildRatingRowView({
        change: buildRatingRowChangeView({ sparkline: null }),
      }),
    });

    expect(ratingRowPage.sparkline("rita.kovac").querySparkline()).toBeNull();
    // The delta figure still shows; only the decorative line is withheld.
    expect(ratingRowPage.queryDelta("rita.kovac")).toBeInTheDocument();
  });

  it("reads a row without a rating change as an unrated player with no delta", () => {
    ratingRowPage.render({ row: buildRatingRowView({ change: null }) });

    expect(ratingRowPage.getNumbers("rita.kovac")).toHaveTextContent(
      /^Unrated player$/,
    );
    expect(ratingRowPage.queryDelta("rita.kovac")).toBeNull();
    expect(ratingRowPage.sparkline("rita.kovac").querySparkline()).toBeNull();
  });
});
