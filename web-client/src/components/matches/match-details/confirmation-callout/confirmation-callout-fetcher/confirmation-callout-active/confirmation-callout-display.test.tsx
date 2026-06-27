import userEvent from "@testing-library/user-event";

import {
  buildAwaitingConfirmationView,
} from "./confirmation-callout-display.factory";
import { confirmationCalloutDisplayPage } from "./confirmation-callout-display.page";

describe("ConfirmationCalloutDisplay", () => {
  describe("actionable variant", () => {
    it("invites the viewer to sign off on the posted result", () => {
      confirmationCalloutDisplayPage.render();

      const callout = confirmationCalloutDisplayPage.getCallout();
      expect(callout).toHaveTextContent(
        "Posted result · awaiting your sign-off",
      );
      expect(callout).toHaveTextContent(
        "Confirm the result to finalize this match.",
      );
      expect(
        confirmationCalloutDisplayPage.getConfirmButton(),
      ).toHaveTextContent("Confirm result");
      expect(
        confirmationCalloutDisplayPage.getDisputeButton(),
      ).toHaveTextContent("Dispute");
      expect(confirmationCalloutDisplayPage.getConfirmButton()).toBeEnabled();
      expect(confirmationCalloutDisplayPage.getDisputeButton()).toBeEnabled();
      expect(
        confirmationCalloutDisplayPage.queryError(),
      ).not.toBeInTheDocument();
    });

    it("fires onConfirm from the primary CTA", async () => {
      const onConfirm = vi.fn();
      const onDispute = vi.fn();
      confirmationCalloutDisplayPage.render({ onConfirm, onDispute });

      await userEvent.click(confirmationCalloutDisplayPage.getConfirmButton());

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onDispute).not.toHaveBeenCalled();
    });

    it("fires onDispute from the secondary CTA", async () => {
      const onConfirm = vi.fn();
      const onDispute = vi.fn();
      confirmationCalloutDisplayPage.render({ onConfirm, onDispute });

      await userEvent.click(confirmationCalloutDisplayPage.getDisputeButton());

      expect(onDispute).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("disables both CTAs and shows the in-flight label while confirming", () => {
      confirmationCalloutDisplayPage.render({ confirmPending: true });

      expect(
        confirmationCalloutDisplayPage.getConfirmButton(),
      ).toHaveTextContent("Confirming…");
      expect(confirmationCalloutDisplayPage.getConfirmButton()).toBeDisabled();
      expect(confirmationCalloutDisplayPage.getDisputeButton()).toBeDisabled();
    });

    it("disables both CTAs and shows the in-flight label while disputing", () => {
      confirmationCalloutDisplayPage.render({ disputePending: true });

      expect(
        confirmationCalloutDisplayPage.getDisputeButton(),
      ).toHaveTextContent("Disputing…");
      expect(confirmationCalloutDisplayPage.getDisputeButton()).toBeDisabled();
      expect(confirmationCalloutDisplayPage.getConfirmButton()).toBeDisabled();
    });

    it("surfaces an API failure inline so the buttons don't appear inert", () => {
      confirmationCalloutDisplayPage.render({
        errorMessage: "Match already finalized",
      });

      expect(confirmationCalloutDisplayPage.queryError()).toHaveTextContent(
        "Match already finalized",
      );
    });
  });

  describe("awaiting variant", () => {
    it("names the signer being waited on, with no CTAs to press", () => {
      confirmationCalloutDisplayPage.render({
        view: buildAwaitingConfirmationView({
          pendingSignerName: "nguyen.t",
        }),
      });

      const callout = confirmationCalloutDisplayPage.getCallout();
      expect(callout).toHaveTextContent("Posted · awaiting confirmation");
      expect(callout).toHaveTextContent(
        "Waiting on nguyen.t to confirm or dispute",
      );
      expect(
        confirmationCalloutDisplayPage.queryConfirmButton(),
      ).not.toBeInTheDocument();
      expect(
        confirmationCalloutDisplayPage.queryDisputeButton(),
      ).not.toBeInTheDocument();
    });

    it("offers a Withdraw CTA to the submitter (#361)", () => {
      confirmationCalloutDisplayPage.render({
        view: buildAwaitingConfirmationView({ canWithdraw: true }),
      });

      expect(confirmationCalloutDisplayPage.getCallout()).toHaveTextContent(
        "Withdraw it to re-score and post again",
      );
      expect(
        confirmationCalloutDisplayPage.getWithdrawButton(),
      ).toHaveTextContent("Withdraw result");
      expect(confirmationCalloutDisplayPage.getWithdrawButton()).toBeEnabled();
    });

    it("hides the Withdraw CTA when the viewer can't withdraw", () => {
      confirmationCalloutDisplayPage.render({
        view: buildAwaitingConfirmationView({ canWithdraw: false }),
      });

      expect(
        confirmationCalloutDisplayPage.queryWithdrawButton(),
      ).not.toBeInTheDocument();
    });

    it("fires onWithdraw from the Withdraw CTA", async () => {
      const onWithdraw = vi.fn();
      confirmationCalloutDisplayPage.render({
        view: buildAwaitingConfirmationView({ canWithdraw: true }),
        onWithdraw,
      });

      await userEvent.click(confirmationCalloutDisplayPage.getWithdrawButton());

      expect(onWithdraw).toHaveBeenCalledTimes(1);
    });

    it("disables the Withdraw CTA and shows the in-flight label while withdrawing", () => {
      confirmationCalloutDisplayPage.render({
        view: buildAwaitingConfirmationView({ canWithdraw: true }),
        withdrawPending: true,
      });

      expect(
        confirmationCalloutDisplayPage.getWithdrawButton(),
      ).toHaveTextContent("Withdrawing…");
      expect(
        confirmationCalloutDisplayPage.getWithdrawButton(),
      ).toBeDisabled();
    });
  });
});
