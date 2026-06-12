import { HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { confirmationCalloutActivePage } from "./confirmation-callout-active.page";

describe("ConfirmationCalloutActive", () => {
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
});
