import { noOpponentProfilePage } from "./no-opponent-profile.page";

describe("NoOpponentProfile", () => {
  it('names the missing side "No opponent" in the ghost tone', () => {
    noOpponentProfilePage.render();

    expect(noOpponentProfilePage.getGhostName()).toBeInTheDocument();
  });

  it("explains the half as a solo match", () => {
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
