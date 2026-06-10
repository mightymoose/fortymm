import { buildPlayerProfileView } from "./player-profile.factory";
import { playerProfilePage } from "./player-profile.page";
import { buildUnratedRatingBoxView } from "./rating-box.factory";
import { buildEmptyRecentFormView } from "./recent-form.factory";

describe("PlayerProfile", () => {
  it("names the player", () => {
    playerProfilePage.render({
      profile: buildPlayerProfileView({ name: "rita.kovac" }),
    });

    expect(playerProfilePage.getName("rita.kovac")).toBeInTheDocument();
  });

  it("tones the initials avatar as a win when the side won", () => {
    playerProfilePage.render({
      profile: buildPlayerProfileView({ won: true }),
    });

    const avatar = playerProfilePage.getAvatar("RK");
    expect(avatar).toHaveClass("md-avatar--win");
    expect(avatar).not.toHaveClass("md-avatar--loss");
  });

  it("tones the avatar as a loss while the side hasn't won", () => {
    playerProfilePage.render({
      profile: buildPlayerProfileView({ won: false }),
    });

    expect(playerProfilePage.getAvatar("RK")).toHaveClass("md-avatar--loss");
  });

  it("renders the rating box from the view's rating", () => {
    // Wiring only: box content is pinned by the rating-box tests.
    playerProfilePage.render({
      profile: buildPlayerProfileView({
        rating: buildUnratedRatingBoxView(),
      }),
    });

    expect(playerProfilePage.getUnrated()).toBeInTheDocument();
  });

  it("renders the recent form from the view's form", () => {
    // Wiring only: block content is pinned by the recent-form tests.
    playerProfilePage.render({
      profile: buildPlayerProfileView({
        form: buildEmptyRecentFormView({ emptyText: "No prior matches yet — this is your first one." }),
      }),
    });

    expect(
      playerProfilePage.getFirstMatchNote(/this is your first one/),
    ).toBeInTheDocument();
  });

  it("renders the career strip from the view's career", () => {
    // Wiring only: strip content is pinned by the career-stats tests.
    playerProfilePage.render();

    expect(playerProfilePage.getCareerMatches()).toHaveTextContent("12");
  });
});
