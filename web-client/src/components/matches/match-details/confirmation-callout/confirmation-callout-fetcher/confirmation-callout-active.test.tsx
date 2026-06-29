import { HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { fireEvent, waitFor } from "@/test/utilities";

import { confirmationCalloutActivePage } from "./confirmation-callout-active.page";

describe("ConfirmationCalloutActive", () => {
  it("fires a single acceptance when Accept is double-clicked in one frame", async () => {
    // Two synchronous clicks before React commits the `disabled` re-render —
    // the double-tap that fired a duplicate POST whose loser 409'd. The
    // in-flight ref must catch the second click.
    let acceptHits = 0;
    confirmationCalloutActivePage.mockAcceptanceEndpoint(() => {
      acceptHits += 1;
      return new Promise<never>(() => {});
    });
    confirmationCalloutActivePage.render();

    const button = await waitFor(() =>
      confirmationCalloutActivePage.getAcceptButton(),
    );
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(acceptHits).toBe(1);
  });

  it("does not fire a second acceptance after the first one succeeds", async () => {
    // The guard clears on error, not on settle: a successful accept unmounts
    // this callout (match completed), but for the beat before that re-render
    // lands the button is still on screen and enabled. A rapid follow-up click
    // in that window must NOT fire a duplicate POST that 409s.
    let acceptHits = 0;
    confirmationCalloutActivePage.mockAcceptanceEndpoint(() => {
      acceptHits += 1;
      return HttpResponse.json(buildMatchDetails(), { status: 201 });
    });
    confirmationCalloutActivePage.render();

    const button = await waitFor(() =>
      confirmationCalloutActivePage.getAcceptButton(),
    );
    await userEvent.click(button);
    await waitFor(() => expect(acceptHits).toBe(1));
    await userEvent.click(button);
    await waitFor(() => {});
    expect(acceptHits).toBe(1);
  });

  it("disables the CTA while the acceptance is in flight", async () => {
    confirmationCalloutActivePage.mockAcceptanceEndpoint(
      () => new Promise<never>(() => {}),
    );
    confirmationCalloutActivePage.render();

    await waitFor(() => confirmationCalloutActivePage.getAcceptButton());
    await userEvent.click(confirmationCalloutActivePage.getAcceptButton());

    await waitFor(() =>
      expect(confirmationCalloutActivePage.getAcceptButton()).toBeDisabled(),
    );
    expect(confirmationCalloutActivePage.getAcceptButton()).toHaveTextContent(
      "Accepting…",
    );
  });

  it("surfaces the API error detail inline when the acceptance is rejected", async () => {
    // e.g. a 409 race: the proposal moved on, or a double click — without
    // inline surfacing the button would appear inert.
    confirmationCalloutActivePage.mockAcceptanceEndpoint(() =>
      HttpResponse.json({ detail: "Match already finalized" }, { status: 409 }),
    );
    confirmationCalloutActivePage.render();

    await waitFor(() => confirmationCalloutActivePage.getAcceptButton());
    await userEvent.click(confirmationCalloutActivePage.getAcceptButton());

    await waitFor(() =>
      expect(confirmationCalloutActivePage.queryError()).toHaveTextContent(
        "Match already finalized",
      ),
    );
  });
});
