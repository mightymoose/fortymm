import userEvent from "@testing-library/user-event";

import { buildAwaitingConfirmationView } from "./confirmation-callout-display.factory";
import { confirmationCalloutDisplayPage } from "./confirmation-callout-display.page";

describe("ConfirmationCalloutDisplay", () => {
  describe("actionable variant", () => {
    it("invites the viewer to accept the posted result", () => {
      confirmationCalloutDisplayPage.render();

      const callout = confirmationCalloutDisplayPage.getCallout();
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
      expect(
        confirmationCalloutDisplayPage.queryError(),
      ).not.toBeInTheDocument();
    });

    it("fires onAccept from the primary CTA", async () => {
      const onAccept = vi.fn();
      confirmationCalloutDisplayPage.render({ onAccept });

      await userEvent.click(confirmationCalloutDisplayPage.getAcceptButton());

      expect(onAccept).toHaveBeenCalledTimes(1);
    });

    it("disables the CTA and shows the in-flight label while accepting", () => {
      confirmationCalloutDisplayPage.render({ acceptPending: true });

      expect(
        confirmationCalloutDisplayPage.getAcceptButton(),
      ).toHaveTextContent("Accepting…");
      expect(confirmationCalloutDisplayPage.getAcceptButton()).toBeDisabled();
    });

    it("surfaces an API failure inline so the button doesn't appear inert", () => {
      confirmationCalloutDisplayPage.render({
        errorMessage: "Match already finalized",
      });

      expect(confirmationCalloutDisplayPage.queryError()).toHaveTextContent(
        "Match already finalized",
      );
    });
  });

  describe("awaiting variant", () => {
    it("names the opponent being waited on, with no CTA to press", () => {
      confirmationCalloutDisplayPage.render({
        view: buildAwaitingConfirmationView({
          pendingSignerName: "nguyen.t",
        }),
      });

      const callout = confirmationCalloutDisplayPage.getCallout();
      expect(callout).toHaveTextContent("Posted · awaiting acceptance");
      expect(callout).toHaveTextContent("Waiting on nguyen.t to accept");
      expect(
        confirmationCalloutDisplayPage.queryAcceptButton(),
      ).not.toBeInTheDocument();
    });
  });
});
