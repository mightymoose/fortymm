import { waitFor } from "@/test/utilities";
import userEvent from "@testing-library/user-event";

import { buildSaveYourMatchView } from "./save-your-match-display.factory";
import { saveYourMatchDisplayPage } from "./save-your-match-display.page";

describe("SaveYourMatchDisplay", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("nudges a guest with opponent + score + CTA to /settings#sec-email", async () => {
    saveYourMatchDisplayPage.mockSession({
      user: { email: null, confirmed_at: null },
    });

    saveYourMatchDisplayPage.render({
      view: buildSaveYourMatchView({
        rightUsername: "okafor.d",
        leftGamesWon: 3,
        rightGamesWon: 1,
      }),
    });

    await saveYourMatchDisplayPage.findPrompt();
    // Anchors on the specific match: opponent name + viewer-first score blips.
    expect(saveYourMatchDisplayPage.getBody()).toHaveTextContent(
      /rivalry with okafor\.d/i,
    );
    expect(
      saveYourMatchDisplayPage.getScoreBlips().map((n) => n.textContent),
    ).toEqual(["3", "1"]);
    // Primary CTA goes to the settings email section.
    expect(saveYourMatchDisplayPage.getSaveCta()).toHaveAttribute(
      "href",
      "/settings#sec-email",
    );
    expect(saveYourMatchDisplayPage.getNotNow()).toBeInTheDocument();
    expect(saveYourMatchDisplayPage.getHint()).toHaveTextContent(/TAKES 20s/);
  });

  it("hides when the viewer already has a confirmed email", async () => {
    saveYourMatchDisplayPage.mockSession({
      user: { email: "rita@example.com", confirmed_at: "2026-05-01T00:00:00Z" },
    });

    saveYourMatchDisplayPage.render();

    // Wait for the session query to resolve before asserting absence — a
    // gate-dropping mutant would surface the prompt once it does, so this
    // combined wait can only settle if the prompt stays hidden.
    await waitFor(() => {
      expect(saveYourMatchDisplayPage.sessionRequestCount()).toBeGreaterThan(0);
      expect(saveYourMatchDisplayPage.queryPrompt()).not.toBeInTheDocument();
    });
    expect(saveYourMatchDisplayPage.queryReceipt()).not.toBeInTheDocument();
  });

  it("hides for a pending-email user — they're no longer a guest", async () => {
    saveYourMatchDisplayPage.mockSession({
      user: {
        email: null,
        confirmed_at: null,
        pending_email: "rita@example.com",
      },
    });

    saveYourMatchDisplayPage.render();

    await waitFor(() => {
      expect(saveYourMatchDisplayPage.sessionRequestCount()).toBeGreaterThan(0);
      expect(saveYourMatchDisplayPage.queryPrompt()).not.toBeInTheDocument();
    });
    expect(saveYourMatchDisplayPage.queryReceipt()).not.toBeInTheDocument();
  });

  it("swaps to a 'save it' receipt after Not now, linking to the email section", async () => {
    saveYourMatchDisplayPage.mockSession({
      user: { email: null, confirmed_at: null },
    });
    const user = userEvent.setup();

    saveYourMatchDisplayPage.render({
      view: buildSaveYourMatchView(),
      matchId: "m-dismiss",
    });

    await saveYourMatchDisplayPage.findPrompt();
    await user.click(saveYourMatchDisplayPage.getNotNow());

    // Full prompt gone; a quiet receipt with a real CTA stays.
    expect(saveYourMatchDisplayPage.queryPrompt()).not.toBeInTheDocument();
    expect(saveYourMatchDisplayPage.getReceipt()).toHaveTextContent(
      /lives on your device only/i,
    );
    expect(saveYourMatchDisplayPage.getReceiptSaveLink()).toHaveAttribute(
      "href",
      "/settings#sec-email",
    );
    // Dismissal is persisted under the per-match key.
    expect(
      window.localStorage.getItem("fm.savePromptDismissed.m-dismiss"),
    ).toBe("1");
  });

  it("stays fully hidden on a revisit once the match was dismissed before", async () => {
    window.localStorage.setItem("fm.savePromptDismissed.m-cold", "1");
    saveYourMatchDisplayPage.mockSession({
      user: { email: null, confirmed_at: null },
    });

    saveYourMatchDisplayPage.render({ matchId: "m-cold" });

    // 'cold' dismissal renders nothing at all — not even the receipt. Wait for
    // session to resolve so a mutant that ignores the cold flag would be caught.
    await waitFor(() => {
      expect(saveYourMatchDisplayPage.sessionRequestCount()).toBeGreaterThan(0);
      expect(saveYourMatchDisplayPage.queryPrompt()).not.toBeInTheDocument();
    });
    expect(saveYourMatchDisplayPage.queryReceipt()).not.toBeInTheDocument();
  });

  it("treats each match independently — a dismissal on another match doesn't silence this one", async () => {
    window.localStorage.setItem("fm.savePromptDismissed.m-other", "1");
    saveYourMatchDisplayPage.mockSession({
      user: { email: null, confirmed_at: null },
    });

    saveYourMatchDisplayPage.render({ matchId: "m-fresh" });

    expect(await saveYourMatchDisplayPage.findPrompt()).toBeInTheDocument();
  });
});
