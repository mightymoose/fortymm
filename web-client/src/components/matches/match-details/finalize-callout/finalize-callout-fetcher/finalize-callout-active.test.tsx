import { HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { buildFinalizeCalloutView } from "./finalize-callout-active/finalize-callout-display.factory";
import { finalizeCalloutActivePage } from "./finalize-callout-active.page";

describe("FinalizeCalloutActive", () => {
  it("posts exactly the view's canonical games, unchanged", async () => {
    let postedBody: unknown = null;
    finalizeCalloutActivePage.mockResultsEndpoint(async ({ request }) => {
      postedBody = await request.json();
      return HttpResponse.json(buildMatchDetails(), { status: 201 });
    });
    const view = buildFinalizeCalloutView();
    finalizeCalloutActivePage.render({ view });

    await userEvent.click(finalizeCalloutActivePage.getPostButton());

    await waitFor(() => expect(postedBody).toEqual({ games: view.games }));
  });

  it("disables the CTA and shows the in-flight label while the post is pending", async () => {
    // Never-resolving response keeps the mutation in flight for the assertion.
    finalizeCalloutActivePage.mockResultsEndpoint(
      () => new Promise<never>(() => {}),
    );
    finalizeCalloutActivePage.render();

    await userEvent.click(finalizeCalloutActivePage.getPostButton());

    await waitFor(() =>
      expect(finalizeCalloutActivePage.getPostButton()).toBeDisabled(),
    );
    expect(finalizeCalloutActivePage.getPostButton()).toHaveTextContent(
      "Posting…",
    );
  });

  it("surfaces the API error detail inline when the post is rejected", async () => {
    // e.g. a 409 race: the opponent confirmed/disputed first, or a double
    // click — without inline surfacing the button would appear inert.
    finalizeCalloutActivePage.mockResultsEndpoint(() =>
      HttpResponse.json(
        { detail: "Match already has a posted result" },
        { status: 409 },
      ),
    );
    finalizeCalloutActivePage.render();

    await userEvent.click(finalizeCalloutActivePage.getPostButton());

    await waitFor(() =>
      expect(finalizeCalloutActivePage.queryError()).toHaveTextContent(
        "Match already has a posted result",
      ),
    );
  });

  it("clears a previous failure when the post is retried", async () => {
    let attempts = 0;
    finalizeCalloutActivePage.mockResultsEndpoint(() => {
      attempts += 1;
      if (attempts === 1) {
        return HttpResponse.json(
          { detail: "Match already has a posted result" },
          { status: 409 },
        );
      }
      // Second attempt: hold the request open so the test can observe the
      // reset-on-retry (error gone) without the retry settling first.
      return new Promise<never>(() => {});
    });
    finalizeCalloutActivePage.render();

    await userEvent.click(finalizeCalloutActivePage.getPostButton());
    await waitFor(() =>
      expect(finalizeCalloutActivePage.queryError()).toBeInTheDocument(),
    );

    await userEvent.click(finalizeCalloutActivePage.getPostButton());

    await waitFor(() =>
      expect(finalizeCalloutActivePage.queryError()).not.toBeInTheDocument(),
    );
  });
});
