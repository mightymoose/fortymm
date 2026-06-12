import {
  buildRatingBoxView,
  buildUnratedRatingBoxView,
} from "./rating-box.factory";
import { ratingBoxPage } from "./rating-box.page";

describe("RatingBox", () => {
  it("shows the pre-match rating with its trend sparkline", () => {
    ratingBoxPage.render({
      rating: buildRatingBoxView({
        value: 1612,
        sparkline: [1580, 1601, 1612],
      }),
    });

    expect(ratingBoxPage.getRating("1612")).toBeInTheDocument();
    expect(ratingBoxPage.getSparkline()).toBeInTheDocument();
  });

  it('dims "Unrated" for a player without a rating', () => {
    ratingBoxPage.render({ rating: buildUnratedRatingBoxView() });

    expect(ratingBoxPage.getUnrated()).toBeInTheDocument();
    expect(ratingBoxPage.querySparkline()).not.toBeInTheDocument();
  });

  it("omits the sparkline when the view carries no history", () => {
    ratingBoxPage.render({
      rating: buildRatingBoxView({ sparkline: null }),
    });

    expect(ratingBoxPage.getRating("1612")).toBeInTheDocument();
    expect(ratingBoxPage.querySparkline()).not.toBeInTheDocument();
  });
});
