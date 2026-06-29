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

  it("surfaces a non-conflict API error inline so the button doesn't appear inert", async () => {
    // A 500 (or any non-409): without inline surfacing the button looks inert.
    confirmationCalloutActivePage.mockAcceptanceEndpoint(() =>
      HttpResponse.json({ detail: "Something went wrong" }, { status: 500 }),
    );
    confirmationCalloutActivePage.render();

    await waitFor(() => confirmationCalloutActivePage.getAcceptButton());
    await userEvent.click(confirmationCalloutActivePage.getAcceptButton());

    await waitFor(() =>
      expect(confirmationCalloutActivePage.queryError()).toHaveTextContent(
        "Something went wrong",
      ),
    );
  });

  it("turns a 409 into a reload-to-re-review prompt, not a silent retarget (#726)", async () => {
    // The standing result moved on between render and click. Accepting the
    // stale token 409s; rather than show the raw detail (or worse, retarget the
    // live result), swap Accept for a reload prompt so finalizing stays a
    // conscious act on a seen score.
    confirmationCalloutActivePage.mockAcceptanceEndpoint(() =>
      HttpResponse.json({ detail: "Result superseded" }, { status: 409 }),
    );
    confirmationCalloutActivePage.render();

    await waitFor(() => confirmationCalloutActivePage.getAcceptButton());
    await userEvent.click(confirmationCalloutActivePage.getAcceptButton());

    await waitFor(() =>
      expect(confirmationCalloutActivePage.queryError()).toHaveTextContent(
        /this result changed — reload/i,
      ),
    );
    // The stale-result Accept is gone; the reload CTA stands in its place.
    expect(
      confirmationCalloutActivePage.queryAcceptButton(),
    ).not.toBeInTheDocument();
    expect(
      confirmationCalloutActivePage.queryReloadButton(),
    ).toBeInTheDocument();
    // The raw server detail is not shown — the dedicated reload copy replaces it.
    expect(confirmationCalloutActivePage.queryError()).not.toHaveTextContent(
      "Result superseded",
    );
  });
});
