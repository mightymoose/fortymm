import { HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { fireEvent, waitFor } from "@/test/utilities";

import { buildFinalizeCalloutView } from "./finalize-callout-active/finalize-callout-display.factory";
import { finalizeCalloutActivePage } from "./finalize-callout-active.page";

/**
 * Wait on the mutation *settling*, not on the alert — the CTA returning from
 * "Posting…" to enabled "Post result" happens in BOTH the fixed and broken
 * states, so this resolves in ~milliseconds either way. React Query commits
 * `isPending=false` and the settled `error` in the SAME state update, so the
 * commit where the button re-enables is the same commit that renders the alert;
 * callers can therefore assert the alert synchronously right after this.
 *
 * If we waited on the alert itself, a regression (no alert) would red as an
 * opaque 5s timeout — `asyncUtilTimeout` == `testTimeout` == 5000, so a missing
 * signal is indistinguishable from a hang. Settling first, then asserting the
 * alert synchronously, makes a missing alert fail fast with a crisp query error.
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
 * same commit the transport-level mutation error settles, so callers assert
 * this synchronously after `settleToRetryable()` rather than waiting on it.
 * Uses the page object's plural `hasErrorMatching` (not a singular
 * `getByRole("alert")`) so a co-rendered second alert can't blow up the query.
 */
const hasConnectionAlert = () =>
  finalizeCalloutActivePage.hasErrorMatching(
    /check your connection and try again/i,
  );

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

  it("surfaces a transport-level failure as a connection alert (#867)", async () => {
    // `useProposeResult` runs `networkMode: 'always'`, so an offline submit
    // fires the POST anyway and `fetch` rejects with a plain `TypeError` — NOT
    // an `ApiError`. `HttpResponse.error()` reproduces that thrown TypeError
    // (a rejected request, not a 500 status). The old code rendered nothing in
    // this branch, leaving the user with zero feedback (#867).
    finalizeCalloutActivePage.mockResultsEndpoint(() => HttpResponse.error());
    finalizeCalloutActivePage.render();

    await userEvent.click(finalizeCalloutActivePage.getPostButton());

    // Settle back from "Posting…" to enabled first, THEN assert the alert
    // synchronously — a missing alert fails as an assertion error in ms, not an
    // opaque 5s timeout.
    await settleToRetryable();
    expect(hasConnectionAlert()).toBe(true);
  });

  it("re-fires the POST when clicked again while still offline (#867 retry)", async () => {
    // After a transport-level failure, `onError` resets the synchronous
    // `inFlightRef` guard, so a second click must actually re-fire the mutation
    // — it must not be dead-locked by a ref that never cleared. Both attempts
    // fail (still offline), so counting the POSTs proves the retry left the
    // boundary rather than being swallowed client-side.
    let requests = 0;
    finalizeCalloutActivePage.mockResultsEndpoint(() => {
      requests += 1;
      return HttpResponse.error();
    });
    finalizeCalloutActivePage.render();

    // First send fails at the transport level. Anchor the wait on the request
    // count — the observable that actually advances — before settling: after a
    // failure the button is already enabled reading "Post result", so a
    // `settleToRetryable()` predicate can resolve on the pre-click render before
    // the POST has left the boundary.
    await userEvent.click(finalizeCalloutActivePage.getPostButton());
    await waitFor(() => expect(requests).toBe(1));
    await settleToRetryable();
    expect(hasConnectionAlert()).toBe(true);

    // Retry: click again. The point being pinned is that the retry actually
    // re-fires — `onError` reset the synchronous `inFlightRef`, so the second
    // click leaves the boundary rather than being swallowed. We wait on the
    // request count reaching 2 (short timeout so a stuck `inFlightRef` reds as a
    // crisp "expected 1 to be 2" fast, never masquerading as the suite's 5s
    // `asyncUtilTimeout`), then settle and assert the alert synchronously.
    await userEvent.click(finalizeCalloutActivePage.getPostButton());
    await waitFor(() => expect(requests).toBe(2), { timeout: 1000 });
    await settleToRetryable();
    expect(hasConnectionAlert()).toBe(true);
  });

  it("clears the stale connection alert after a reconnecting retry succeeds (#867 reconnect)", async () => {
    // First submit fails at the transport level (offline), rendering the
    // connection alert. Once the endpoint recovers, a second click must succeed
    // and the stale connection alert must not linger — the success resets the
    // mutation error.
    let requests = 0;
    finalizeCalloutActivePage.mockResultsEndpoint(() => {
      requests += 1;
      return HttpResponse.error();
    });
    finalizeCalloutActivePage.render();

    // Anchor on the request count first (the observable that advances), then
    // settle and assert the alert synchronously — the same discipline the retry
    // test uses, so an already-enabled button can't resolve `settleToRetryable`
    // before the POST has left the boundary.
    await userEvent.click(finalizeCalloutActivePage.getPostButton());
    await waitFor(() => expect(requests).toBe(1));
    await settleToRetryable();
    expect(hasConnectionAlert()).toBe(true);

    // Reconnect: the endpoint now succeeds. `server.use` prepends, so this
    // handler wins for the retry.
    finalizeCalloutActivePage.mockResultsEndpoint(() => {
      requests += 1;
      return HttpResponse.json(buildMatchDetails(), { status: 201 });
    });

    await userEvent.click(finalizeCalloutActivePage.getPostButton());
    await waitFor(() => expect(requests).toBe(2));
    await settleToRetryable();

    // The success path does not keep showing the stale connection alert.
    expect(hasConnectionAlert()).toBe(false);
  });

  it("shows the server's 409 detail, not the connection copy (branches don't cross)", async () => {
    // A 409 is an `ApiError`, not a transport TypeError, so the `apiError`
    // branch — the server's `detail` copy — must win. The connection copy must
    // NOT appear (guard against the two error branches crossing).
    finalizeCalloutActivePage.mockResultsEndpoint(() =>
      HttpResponse.json(
        { detail: "Match already has a posted result" },
        { status: 409 },
      ),
    );
    finalizeCalloutActivePage.render();

    await userEvent.click(finalizeCalloutActivePage.getPostButton());

    await settleToRetryable();
    expect(
      finalizeCalloutActivePage.hasErrorMatching(
        /Match already has a posted result/,
      ),
    ).toBe(true);
    expect(hasConnectionAlert()).toBe(false);
  });
});
