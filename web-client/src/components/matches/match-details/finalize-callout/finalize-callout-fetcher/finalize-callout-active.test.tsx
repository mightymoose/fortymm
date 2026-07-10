import { HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { fireEvent, waitFor } from "@/test/utilities";

import { buildFinalizeCalloutView } from "./finalize-callout-active/finalize-callout-display.factory";
import { finalizeCalloutActivePage } from "./finalize-callout-active.page";

/**
 * Wait on the mutation *settling* (button back from "Posting…" to an enabled
 * "Post result"), not on the alert — the button re-enables in BOTH the fixed
 * and broken states, so this resolves in ~milliseconds either way. If we waited
 * on the alert itself, a regression (no alert) would red as an opaque 5s timeout
 * (`asyncUtilTimeout` == `testTimeout` == 5000, so a missing signal is
 * indistinguishable from a hang). Settling first, then asserting the alert
 * synchronously, makes a missing alert fail fast with a crisp query error.
 */
async function settleToRetryable() {
  await waitFor(() => {
    const button = finalizeCalloutActivePage.getPostButton();
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Post result");
  });
}

/**
 * Whether the #867 connection alert is currently in the DOM. It renders in the
 * same commit the mutation error settles, so callers assert this synchronously
 * after `settleToRetryable()` rather than waiting on it.
 */
function hasConnectionAlert() {
  const alert = finalizeCalloutActivePage.queryError();
  return /Couldn't post this result .* check your connection and try again/i.test(
    alert?.textContent ?? "",
  );
}

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

  it("fires a single POST when the button is double-clicked in one frame", async () => {
    // Two synchronous clicks before React commits the `disabled` re-render —
    // the double-tap that fired two concurrent POST /results and wedged the
    // backend (#641). `disabled={pending}` can't catch the second click here
    // (it only takes effect next render), so the synchronous in-flight ref must.
    let requests = 0;
    finalizeCalloutActivePage.mockResultsEndpoint(() => {
      requests += 1;
      return new Promise<never>(() => {});
    });
    finalizeCalloutActivePage.render();

    const button = finalizeCalloutActivePage.getPostButton();
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(requests).toBe(1);
  });

  it("does not fire a second POST after the first one succeeds", async () => {
    // The guard clears on error, not on settle: a successful post transitions
    // the match to awaiting-confirmation and unmounts this callout, but for the
    // beat before that re-render lands the button is still on screen and
    // enabled. A rapid follow-up click in that window must NOT fire a duplicate
    // POST that 409s (#641 follow-up QA found exactly this leak when the ref
    // cleared on settle).
    let requests = 0;
    finalizeCalloutActivePage.mockResultsEndpoint(() => {
      requests += 1;
      return HttpResponse.json(buildMatchDetails(), { status: 201 });
    });
    finalizeCalloutActivePage.render();

    const button = finalizeCalloutActivePage.getPostButton();
    await userEvent.click(button);
    await waitFor(() => expect(requests).toBe(1));
    // First post settled successfully; the button is enabled again in this
    // isolated harness (no parent to unmount it). A second click must still be
    // swallowed by the guard.
    await userEvent.click(button);
    await waitFor(() => {});
    expect(requests).toBe(1);
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
    // e.g. a 409 race: the opponent accepted/countered first, or a double
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

  it("surfaces a transport-level failure inline and leaves Post retryable (#867)", async () => {
    // `useProposeResult` runs `networkMode: 'always'`, so an offline (or
    // mid-flight-dropped) submit fires the POST and `fetch` rejects with a plain
    // `TypeError` — NOT an `ApiError`. The old code only handled `ApiError`, so
    // this rejection rendered nothing here and re-enabled the button silently,
    // with no other affordance to explain the dead button. `HttpResponse.error()`
    // rejects at the transport level (no status code), reproducing that drop.
    finalizeCalloutActivePage.mockResultsEndpoint(() => HttpResponse.error());
    finalizeCalloutActivePage.render();

    await userEvent.click(finalizeCalloutActivePage.getPostButton());

    await settleToRetryable();

    // Assert the alert synchronously (crisp fail if it never rendered) rather
    // than via a `waitFor` that would red as an opaque 5s timeout on regression.
    expect(hasConnectionAlert()).toBe(true);
  });
});
