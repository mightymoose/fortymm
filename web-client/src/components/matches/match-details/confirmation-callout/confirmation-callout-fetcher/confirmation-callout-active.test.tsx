import { HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { fireEvent, waitFor } from "@/test/utilities";

import { confirmationCalloutActivePage } from "./confirmation-callout-active.page";

vi.mock("sonner", async () => {
  const actual = await vi.importActual<typeof import("sonner")>("sonner");
  return { ...actual, toast: { ...actual.toast, success: vi.fn() } };
});

describe("ConfirmationCalloutActive", () => {
  beforeEach(() => vi.mocked(toast.success).mockClear());
  it("fires a single /confirmation when Confirm is double-clicked in one frame", async () => {
    // Two synchronous clicks before React commits the `disabled` re-render —
    // the double-tap that fired a duplicate POST /confirmation whose loser
    // 409'd (#641 follow-up). `disabled={pending}` can't catch the second click
    // here (it only takes effect next render), so the in-flight ref must.
    let confirmHits = 0;
    confirmationCalloutActivePage.mockConfirmationEndpoint(() => {
      confirmHits += 1;
      return new Promise<never>(() => {});
    });
    confirmationCalloutActivePage.render();

    const button = confirmationCalloutActivePage.getConfirmButton();
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(confirmHits).toBe(1);
  });

  it("fires a single /dispute when Dispute is double-clicked in one frame", async () => {
    let disputeHits = 0;
    confirmationCalloutActivePage.mockDisputeEndpoint(() => {
      disputeHits += 1;
      return new Promise<never>(() => {});
    });
    confirmationCalloutActivePage.render();

    const button = confirmationCalloutActivePage.getDisputeButton();
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(disputeHits).toBe(1);
  });

  it("does not fire a second confirmation after the first one succeeds", async () => {
    // The guard clears on error, not on settle: a successful confirm unmounts
    // this callout (match completed), but for the beat before that re-render
    // lands the button is still on screen and enabled. A rapid follow-up click
    // in that window must NOT fire a duplicate POST that 409s (#641 follow-up
    // QA found exactly this leak when the ref was cleared on settle).
    let confirmHits = 0;
    confirmationCalloutActivePage.mockConfirmationEndpoint(() => {
      confirmHits += 1;
      return HttpResponse.json(buildMatchDetails(), { status: 201 });
    });
    confirmationCalloutActivePage.render();

    const button = confirmationCalloutActivePage.getConfirmButton();
    await userEvent.click(button);
    await waitFor(() => expect(confirmHits).toBe(1));
    // The first confirm has settled successfully; the button is enabled again
    // in this isolated harness (no parent to unmount it). A second click must
    // still be swallowed by the guard.
    await userEvent.click(button);
    await waitFor(() => {});
    expect(confirmHits).toBe(1);
  });

  it("confirming posts to /confirmation exactly once and never /dispute", async () => {
    let confirmHits = 0;
    let disputeHits = 0;
    confirmationCalloutActivePage.mockConfirmationEndpoint(() => {
      confirmHits += 1;
      return HttpResponse.json(buildMatchDetails(), { status: 201 });
    });
    confirmationCalloutActivePage.mockDisputeEndpoint(() => {
      disputeHits += 1;
      return HttpResponse.json(buildMatchDetails());
    });
    confirmationCalloutActivePage.render();

    await userEvent.click(confirmationCalloutActivePage.getConfirmButton());

    await waitFor(() => expect(confirmHits).toBe(1));
    expect(disputeHits).toBe(0);
  });

  it("disputing posts to /dispute exactly once and never /confirmation", async () => {
    let confirmHits = 0;
    let disputeHits = 0;
    confirmationCalloutActivePage.mockConfirmationEndpoint(() => {
      confirmHits += 1;
      return HttpResponse.json(buildMatchDetails(), { status: 201 });
    });
    confirmationCalloutActivePage.mockDisputeEndpoint(() => {
      disputeHits += 1;
      return HttpResponse.json(buildMatchDetails());
    });
    confirmationCalloutActivePage.render();

    await userEvent.click(confirmationCalloutActivePage.getDisputeButton());

    await waitFor(() => expect(disputeHits).toBe(1));
    expect(confirmHits).toBe(0);
  });

  it("disables both CTAs while a mutation is in flight", async () => {
    // Never-resolving response keeps the confirm in flight for the assertion.
    confirmationCalloutActivePage.mockConfirmationEndpoint(
      () => new Promise<never>(() => {}),
    );
    confirmationCalloutActivePage.render();

    await userEvent.click(confirmationCalloutActivePage.getConfirmButton());

    await waitFor(() =>
      expect(confirmationCalloutActivePage.getConfirmButton()).toBeDisabled(),
    );
    expect(confirmationCalloutActivePage.getConfirmButton()).toHaveTextContent(
      "Confirming…",
    );
    expect(confirmationCalloutActivePage.getDisputeButton()).toBeDisabled();
  });

  it("surfaces the API error detail inline when a mutation is rejected", async () => {
    // e.g. a 409 race: the opponent confirmed/disputed first, or a double
    // click — without inline surfacing the buttons would appear inert.
    confirmationCalloutActivePage.mockConfirmationEndpoint(() =>
      HttpResponse.json({ detail: "Match already finalized" }, { status: 409 }),
    );
    confirmationCalloutActivePage.render();

    await userEvent.click(confirmationCalloutActivePage.getConfirmButton());

    await waitFor(() =>
      expect(confirmationCalloutActivePage.queryError()).toHaveTextContent(
        "Match already finalized",
      ),
    );
  });

  it("clears a failed dispute's error when the user changes course and confirms", async () => {
    confirmationCalloutActivePage.mockDisputeEndpoint(() =>
      HttpResponse.json({ detail: "Dispute window closed" }, { status: 409 }),
    );
    // Hold the confirm open so the test can observe the reset (dispute error
    // gone) without the confirm settling first.
    confirmationCalloutActivePage.mockConfirmationEndpoint(
      () => new Promise<never>(() => {}),
    );
    confirmationCalloutActivePage.render();

    await userEvent.click(confirmationCalloutActivePage.getDisputeButton());
    await waitFor(() =>
      expect(confirmationCalloutActivePage.queryError()).toHaveTextContent(
        "Dispute window closed",
      ),
    );

    await userEvent.click(confirmationCalloutActivePage.getConfirmButton());

    await waitFor(() =>
      expect(
        confirmationCalloutActivePage.queryError(),
      ).not.toBeInTheDocument(),
    );
  });

  it("acknowledges a successful dispute with a toast (#359)", async () => {
    // Dispute unmounts this callout, so without an explicit acknowledgement the
    // disputer gets no signal their click did anything. The copy stays neutral
    // about who re-scores — after a dispute either player can correct the games.
    confirmationCalloutActivePage.mockDisputeEndpoint(() =>
      HttpResponse.json(buildMatchDetails()),
    );
    confirmationCalloutActivePage.render();

    await userEvent.click(confirmationCalloutActivePage.getDisputeButton());

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Dispute sent.",
        expect.objectContaining({
          description: expect.stringContaining("back in progress"),
        }),
      ),
    );
  });

  it("posts to /withdrawal once and acknowledges with a toast (#361)", async () => {
    let withdrawHits = 0;
    confirmationCalloutActivePage.mockWithdrawalEndpoint(() => {
      withdrawHits += 1;
      return HttpResponse.json(buildMatchDetails());
    });
    confirmationCalloutActivePage.render({
      view: confirmationCalloutActivePage.awaitingView({ canWithdraw: true }),
    });

    await userEvent.click(confirmationCalloutActivePage.getWithdrawButton());

    await waitFor(() => expect(withdrawHits).toBe(1));
    expect(toast.success).toHaveBeenCalledWith(
      "Result withdrawn.",
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it("fires a single /withdrawal when Withdraw is double-clicked in one frame", async () => {
    let withdrawHits = 0;
    confirmationCalloutActivePage.mockWithdrawalEndpoint(() => {
      withdrawHits += 1;
      return new Promise<never>(() => {});
    });
    confirmationCalloutActivePage.render({
      view: confirmationCalloutActivePage.awaitingView({ canWithdraw: true }),
    });

    const button = confirmationCalloutActivePage.getWithdrawButton();
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(withdrawHits).toBe(1);
  });

  it("surfaces a withdrawal failure inline without acknowledging it", async () => {
    confirmationCalloutActivePage.mockWithdrawalEndpoint(() =>
      HttpResponse.json(
        { detail: "This match is no longer awaiting confirmation." },
        { status: 409 },
      ),
    );
    confirmationCalloutActivePage.render({
      view: confirmationCalloutActivePage.awaitingView({ canWithdraw: true }),
    });

    await userEvent.click(confirmationCalloutActivePage.getWithdrawButton());

    await waitFor(() =>
      expect(confirmationCalloutActivePage.queryError()).toHaveTextContent(
        "This match is no longer awaiting confirmation.",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
