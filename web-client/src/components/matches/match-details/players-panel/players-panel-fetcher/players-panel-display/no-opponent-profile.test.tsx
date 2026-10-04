import { noOpponentProfilePage } from "./no-opponent-profile.page";

describe("NoOpponentProfile", () => {
  it('names the empty side "Unlisted opponent" in the ghost tone', () => {
    noOpponentProfilePage.render();

    expect(noOpponentProfilePage.getGhostName()).toBeInTheDocument();
  });

  it("explains an unlisted opponent as off FortyMM, or no one at all", () => {
    noOpponentProfilePage.render();

    expect(noOpponentProfilePage.getSoloNote()).toBeInTheDocument();
  });

  it("hides the dashed avatar from assistive tech — the name carries the info", () => {
    noOpponentProfilePage.render();

    const avatar = noOpponentProfilePage
      .getGhostName()
      .closest(".md-profile")!
      .querySelector(".md-avatar--ghost");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
  });
});
