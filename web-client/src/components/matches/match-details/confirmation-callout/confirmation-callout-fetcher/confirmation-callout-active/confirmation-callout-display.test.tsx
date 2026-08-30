import userEvent from "@testing-library/user-event";

import { newResultRoute } from "@/api/matches";
import { waitFor } from "@/test/utilities";

import {
  buildAwaitingAcceptanceView,
  buildCorrectedConfirmationView,
  buildReviewConfirmationView,
} from "./confirmation-callout-display.factory";
import { confirmationCalloutDisplayPage } from "./confirmation-callout-display.page";

// The callout mounts behind a memory router (the correction links are typed
// `<Link>`s), so the section resolves a tick after render.
const correctHref = (matchId: string) =>
  `/matches/${newResultRoute(matchId).params.matchId}/results/new`;

describe("ConfirmationCalloutDisplay", () => {
  describe("review variant", () => {
    it("invites the viewer to accept or suggest a correction, with the rated stakes", async () => {
      confirmationCalloutDisplayPage.render();

      const callout = await waitFor(() =>
        confirmationCalloutDisplayPage.getCallout(),
      );
      expect(callout).toHaveTextContent(
        "Posted result · awaiting your acceptance",
      );
      expect(callout).toHaveTextContent(
        "Accept the result to finalize this match.",
      );
      expect(
        confirmationCalloutDisplayPage.getAcceptButton(),
      ).toHaveTextContent("Accept result");
      expect(confirmationCalloutDisplayPage.getAcceptButton()).toBeEnabled();
      // The rated stakes line is shown.
      expect(callout).toHaveTextContent(/rated match/i);
      // "Suggest correction" links into the correction route.
      expect(
        confirmationCalloutDisplayPage.querySuggestCorrectionLink(),
      ).toHaveAttribute("href", correctHref("m-1"));
      expect(
        confirmationCalloutDisplayPage.queryError(),
      ).not.toBeInTheDocument();
    });

    it("addresses the tournament's director in their own voice, with Accept as their only action", async () => {
      // A director isn't playing, so "your opponent" is wrong, and the
      // correction route redirects anyone with no side straight back to the
      // match — offering it here would be a link to a bounce (#1523).
      confirmationCalloutDisplayPage.render({
        view: buildReviewConfirmationView({ officiating: true }),
      });

      const callout = await waitFor(() =>
        confirmationCalloutDisplayPage.getCallout(),
      );
      expect(callout).toHaveTextContent(
        "A player has posted the result below. As this tournament's director you can accept it to finalize the match.",
      );
      expect(callout).not.toHaveTextContent(/your opponent/i);
      expect(confirmationCalloutDisplayPage.getAcceptButton()).toBeEnabled();
      expect(
        confirmationCalloutDisplayPage.querySuggestCorrectionLink(),
      ).not.toBeInTheDocument();
    });

    it("shows the unrated stakes when the match doesn't affect ratings", async () => {
      confirmationCalloutDisplayPage.render({
        view: {
          kind: "review",
          resultId: "r-1",
          rated: false,
          retirementDeadline: null,
          officiating: false,
        },
      });

      const callout = await waitFor(() =>
        confirmationCalloutDisplayPage.getCallout(),
      );
      expect(callout).toHaveTextContent(/doesn't affect ratings/i);
    });

    it("fires onAccept from the primary CTA", async () => {
      const onAccept = vi.fn();
      confirmationCalloutDisplayPage.render({ onAccept });

      await waitFor(() => confirmationCalloutDisplayPage.getCallout());
      await userEvent.click(confirmationCalloutDisplayPage.getAcceptButton());

      expect(onAccept).toHaveBeenCalledTimes(1);
    });

    it("disables the CTA and shows the in-flight label while accepting", async () => {
      confirmationCalloutDisplayPage.render({ acceptPending: true });

      await waitFor(() => confirmationCalloutDisplayPage.getCallout());
      expect(
        confirmationCalloutDisplayPage.getAcceptButton(),
      ).toHaveTextContent("Accepting…");
      expect(confirmationCalloutDisplayPage.getAcceptButton()).toBeDisabled();
    });

    it("surfaces an API failure inline so the button doesn't appear inert", async () => {
      confirmationCalloutDisplayPage.render({
        errorMessage: "Match already finalized",
      });

      await waitFor(() => confirmationCalloutDisplayPage.getCallout());
      expect(confirmationCalloutDisplayPage.queryError()).toHaveTextContent(
        "Match already finalized",
      );
    });

    it("swaps Accept for a reload prompt when the result moved on (#726)", async () => {
      const onReload = vi.fn();
      confirmationCalloutDisplayPage.render({ staleConflict: true, onReload });

      await waitFor(() => confirmationCalloutDisplayPage.getCallout());
      // The stale-result Accept is gone — finalizing an unseen result is the bug.
      expect(
        confirmationCalloutDisplayPage.queryAcceptButton(),
      ).not.toBeInTheDocument();
      expect(confirmationCalloutDisplayPage.queryError()).toHaveTextContent(
        /this result changed — reload/i,
      );
      await userEvent.click(confirmationCalloutDisplayPage.getReloadButton());
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("shows the retirement countdown when the view carries a deadline", async () => {
      confirmationCalloutDisplayPage.render({
        view: buildReviewConfirmationView({
          // 3 days + 1h of margin so the floor stays at 3 despite test elapsed time.
          retirementDeadline: new Date(
            Date.now() + 3 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000,
          ).toISOString(),
        }),
      });

      await waitFor(() => confirmationCalloutDisplayPage.getCallout());
      // Wiring only: the exact copy/tone is pinned by the retirement-countdown tests.
      expect(confirmationCalloutDisplayPage.getCountdown()).toHaveTextContent(
        "3 days left to respond",
      );
    });

    it("renders no countdown when the view has no deadline", async () => {
      confirmationCalloutDisplayPage.render({
        view: buildReviewConfirmationView({ retirementDeadline: null }),
      });

      await waitFor(() => confirmationCalloutDisplayPage.getCallout());
      expect(
        confirmationCalloutDisplayPage.queryCountdown(),
      ).not.toBeInTheDocument();
    });

    it("hides the raw error message once a 409 is treated as a stale conflict", async () => {
      // The active wrapper nulls `errorMessage` on a 409, but assert the display
      // prefers the reload copy even if both were somehow set.
      confirmationCalloutDisplayPage.render({
        staleConflict: true,
        errorMessage: "Conflict",
      });

      await waitFor(() => confirmationCalloutDisplayPage.getCallout());
      expect(confirmationCalloutDisplayPage.queryError()).not.toHaveTextContent(
        "Conflict",
      );
    });
  });

  describe("corrected variant", () => {
    it("renders the diff and Accept / Counter affordances", async () => {
      confirmationCalloutDisplayPage.render({
        view: buildCorrectedConfirmationView(),
      });

      const callout = await waitFor(() =>
        confirmationCalloutDisplayPage.getCallout(),
      );
      expect(callout).toHaveTextContent("Your opponent corrected the score.");
      // The #720 ScoreDiff is embedded, showing both diff rows.
      const diff = confirmationCalloutDisplayPage.queryDiff();
      expect(diff).toBeInTheDocument();
      expect(diff).toHaveTextContent("11–7");
      expect(diff).toHaveTextContent("11–9");
      // Accept stays, plus a "Counter" link into the correction route.
      expect(confirmationCalloutDisplayPage.getAcceptButton()).toBeEnabled();
      expect(confirmationCalloutDisplayPage.queryCounterLink()).toHaveAttribute(
        "href",
        correctHref("m-1"),
      );
    });

    it("shows the retirement countdown when the corrected view carries a deadline", async () => {
      confirmationCalloutDisplayPage.render({
        view: buildCorrectedConfirmationView({
          // 5h + 10m of margin so the floor stays at 5 despite test elapsed time.
          retirementDeadline: new Date(
            Date.now() + 5 * 60 * 60 * 1000 + 10 * 60 * 1000,
          ).toISOString(),
        }),
      });

      await waitFor(() => confirmationCalloutDisplayPage.getCallout());
      // Wiring only: the exact copy/tone is pinned by the retirement-countdown tests.
      expect(confirmationCalloutDisplayPage.getCountdown()).toHaveTextContent(
        "5 hours left to respond",
      );
    });

    it("swaps Accept for a reload prompt on a stale conflict, keeping Counter (#726)", async () => {
      confirmationCalloutDisplayPage.render({
        view: buildCorrectedConfirmationView(),
        staleConflict: true,
      });

      const callout = await waitFor(() =>
        confirmationCalloutDisplayPage.getCallout(),
      );
      expect(
        confirmationCalloutDisplayPage.queryAcceptButton(),
      ).not.toBeInTheDocument();
      expect(
        confirmationCalloutDisplayPage.queryReloadButton(),
      ).toBeInTheDocument();
      // (The diff itself is a shadcn Alert, so assert the copy via the callout
      // text rather than a role=alert query that would match both.)
      expect(callout).toHaveTextContent(/this result changed — reload/i);
      // Countering is still available — the diff just needs a fresh baseline.
      expect(
        confirmationCalloutDisplayPage.queryCounterLink(),
      ).toBeInTheDocument();
    });
  });

  describe("awaiting variant", () => {
    it("names the opponent and offers an Edit result self-edit, no Accept", async () => {
      confirmationCalloutDisplayPage.render({
        view: buildAwaitingAcceptanceView({ pendingSignerName: "nguyen.t" }),
      });

      const callout = await waitFor(() =>
        confirmationCalloutDisplayPage.getCallout(),
      );
      expect(callout).toHaveTextContent("Posted · awaiting acceptance");
      expect(callout).toHaveTextContent("Waiting on nguyen.t to accept");
      expect(
        confirmationCalloutDisplayPage.queryAcceptButton(),
      ).not.toBeInTheDocument();
      expect(confirmationCalloutDisplayPage.queryEditLink()).toHaveAttribute(
        "href",
        correctHref("m-1"),
      );
    });
  });
});
