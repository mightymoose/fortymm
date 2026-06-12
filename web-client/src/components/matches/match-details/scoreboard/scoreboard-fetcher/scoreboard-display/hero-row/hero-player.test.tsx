import {
  buildGhostHeroSideView,
  buildHeroSideView,
} from "./hero-player.factory";
import { heroPlayerPage } from "./hero-player.page";

describe("HeroPlayer", () => {
  it("renders the player's name at the end of the row it was positioned on", () => {
    heroPlayerPage.render({
      side: buildHeroSideView({ name: "rita.kovac" }),
      pos: "r",
    });

    expect(heroPlayerPage.getPlayerName("r", "rita.kovac")).toBeInTheDocument();
    expect(
      heroPlayerPage.queryPlayerName("l", "rita.kovac"),
    ).not.toBeInTheDocument();
  });

  it("shows the player's initials in a win-toned avatar when the side won", () => {
    heroPlayerPage.render({ side: buildHeroSideView({ won: true }) });

    const avatar = heroPlayerPage.getPlayerAvatar("RK");
    expect(avatar).toHaveClass("md-avatar--win");
    expect(avatar).not.toHaveClass("md-avatar--loss");
  });

  it("tones the avatar as a loss when the side hasn't won", () => {
    heroPlayerPage.render({ side: buildHeroSideView({ won: false }) });

    const avatar = heroPlayerPage.getPlayerAvatar("RK");
    expect(avatar).toHaveClass("md-avatar--loss");
    expect(avatar).not.toHaveClass("md-avatar--win");
  });

  it("highlights a winning side's name", () => {
    heroPlayerPage.render({ side: buildHeroSideView({ won: true }) });

    expect(heroPlayerPage.getPlayerName("l", "rita.kovac")).toHaveClass(
      "md-hero__name--win",
    );
  });

  it("does not highlight the name of a side still playing", () => {
    heroPlayerPage.render({ side: buildHeroSideView({ won: false }) });

    expect(heroPlayerPage.getPlayerName("l", "rita.kovac")).not.toHaveClass(
      "md-hero__name--win",
    );
  });

  it('renders a ghost side as a "No opponent" placeholder without an initials avatar', () => {
    heroPlayerPage.render({ side: buildGhostHeroSideView() });

    const name = heroPlayerPage.getPlayerName("l", "No opponent");
    expect(name).toHaveClass("md-hero__name--ghost");
    expect(heroPlayerPage.queryPlayerAvatar("NO")).not.toBeInTheDocument();
  });
});
