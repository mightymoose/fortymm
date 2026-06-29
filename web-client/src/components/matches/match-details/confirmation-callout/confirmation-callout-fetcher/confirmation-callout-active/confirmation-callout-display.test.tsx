import userEvent from "@testing-library/user-event";

import { correctionRoute } from "@/api/matches";
import { waitFor } from "@/test/utilities";

import {
  buildAwaitingConfirmationView,
  buildCorrectedConfirmationView,
  buildFinalConfirmationView,
} from "./confirmation-callout-display.factory";
import { confirmationCalloutDisplayPage } from "./confirmation-callout-display.page";

// The callout mounts behind a memory router (the correction links are typed
// `<Link>`s), so the section resolves a tick after render.
const correctHref = (matchId: string) =>
  `/matches/${correctionRoute(matchId).params.matchId}/correct`;

describe("ConfirmationCalloutDisplay", () => {
  describe("review variant", () => {
    it("invites the viewer to accept or suggest a correction, with the rated stakes", async () => {
      confirmationCalloutDisplayPage.render();

      const callout = await waitFor(() =>
        confirmationCalloutDisplayPage.getCallout(),
      );
      expect(callout).toHaveTextContent(
        "Posted result · awaiting your sign-off",
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

    it("shows the unrated stakes when the match doesn't affect ratings", async () => {
      confirmationCalloutDisplayPage.render({
        view: { kind: "review", resultId: "r-1", rated: false },
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
        view: buildAwaitingConfirmationView({ pendingSignerName: "nguyen.t" }),
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

  describe("final variant", () => {
    it("reads 'Confirmed' when there was no back-and-forth", async () => {
      confirmationCalloutDisplayPage.render({
        view: buildFinalConfirmationView({ afterCorrections: false }),
      });

      const callout = await waitFor(() =>
        confirmationCalloutDisplayPage.getCallout(),
      );
      expect(callout).toHaveTextContent("Confirmed");
      expect(callout).not.toHaveTextContent("after corrections");
      expect(
        confirmationCalloutDisplayPage.queryAcceptButton(),
      ).not.toBeInTheDocument();
    });

    it("reads 'Agreed after corrections' when a prior proposal preceded the agreement", async () => {
      confirmationCalloutDisplayPage.render({
        view: buildFinalConfirmationView({ afterCorrections: true }),
      });

      const callout = await waitFor(() =>
        confirmationCalloutDisplayPage.getCallout(),
      );
      expect(callout).toHaveTextContent("Agreed after corrections");
    });
  });
});
