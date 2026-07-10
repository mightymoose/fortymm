import { HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { screen, waitFor } from "@/test/utilities";

import {
  STANDING_RESULT_ID,
  buildCorrectableMatch,
  buildStandingResult,
} from "./correction-entry.factory";
import { correctionEntryPage } from "./correction-entry.page";

/** Re-type a side's score in the open pad. */
async function retype(input: HTMLInputElement, value: string) {
  await userEvent.clear(input);
  if (value !== "") await userEvent.type(input, value);
}

describe("CorrectionEntry", () => {
  it("opens game 1 pre-filled from the standing-result snapshot, viewer-left", async () => {
    // The seed's standing result is the opponent's 3–0 board (11–8, 11–6,
    // 11–9). The viewer is side 1 (rita.kovac), so the left field reads
    // side_1_points and the right reads side_2_points.
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(buildCorrectableMatch()),
    );
    correctionEntryPage.render();

    await waitFor(() =>
      expect(correctionEntryPage.getInput("rita.kovac")).toHaveValue("11"),
    );
    expect(correctionEntryPage.getInput("leo.mertens")).toHaveValue("8");

    // Switch games via the scoreline — the pad re-seeds for the chosen game.
    await correctionEntryPage.selectGame(2);
    expect(correctionEntryPage.getInput("leo.mertens")).toHaveValue("6");
    await correctionEntryPage.selectGame(3);
    expect(correctionEntryPage.getInput("leo.mertens")).toHaveValue("9");
  });

  it("posts the corrected board with supersedes_result_id and navigates home on success", async () => {
    let postedBody: unknown = null;
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(buildCorrectableMatch()),
    );
    correctionEntryPage.mockPropose(async ({ request }) => {
      postedBody = await request.json();
      return HttpResponse.json(buildMatchDetails(), { status: 201 });
    });
    correctionEntryPage.render();

    // Correct game 1: the opponent scored it 11–8; the viewer says 11–7. The
    // board stays a decided 3–0, so Send is enabled.
    const opp1 = await waitFor(() => correctionEntryPage.getInput("leo.mertens"));
    await retype(opp1, "7");

    await userEvent.click(correctionEntryPage.getSubmit());

    await waitFor(() =>
      expect(postedBody).toEqual({
        supersedes_result_id: STANDING_RESULT_ID,
        games: [
          { game_number: 1, side_1_points: 11, side_2_points: 7 },
          { game_number: 2, side_1_points: 11, side_2_points: 6 },
          { game_number: 3, side_1_points: 11, side_2_points: 9 },
        ],
      }),
    );
    await waitFor(() =>
      expect(correctionEntryPage.queryMatchLanding()).toBeInTheDocument(),
    );
  });

  it("blocks submit when flipping a winner leaves the match undecided, then re-enables once a game is added (#734)", async () => {
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(buildCorrectableMatch()),
    );
    correctionEntryPage.render();
    await waitFor(() => correctionEntryPage.getInput("rita.kovac"));

    // Flip game 3 so the viewer loses it 9–11: the board drops to 2–1, no side
    // has 3 wins — undecided.
    await correctionEntryPage.selectGame(3);
    await retype(correctionEntryPage.getInput("rita.kovac"), "9");
    await retype(correctionEntryPage.getInput("leo.mertens"), "11");

    await waitFor(() =>
      expect(
        correctionEntryPage
          .queryAlerts()
          .some((a: HTMLElement) =>
            /isn't a finished match yet/i.test(a.textContent ?? ""),
          ),
      ).toBe(true),
    );
    expect(correctionEntryPage.getSubmit()).toBeDisabled();

    // Add game 4 as a viewer win (11–7): the board becomes 3–1, decided — Send
    // lights back up.
    await correctionEntryPage.selectGame(4);
    await retype(correctionEntryPage.getInput("rita.kovac"), "11");
    await retype(correctionEntryPage.getInput("leo.mertens"), "7");

    await waitFor(() =>
      expect(correctionEntryPage.getSubmit()).toBeEnabled(),
    );
  });

  it("clears a game from the scoreline ✕ and from the in-pad Clear button", async () => {
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(buildCorrectableMatch()),
    );
    correctionEntryPage.render();

    await waitFor(() => correctionEntryPage.getInput("rita.kovac"));

    // Scoreline ✕ on game 3 empties it (board → 2–0, undecided).
    await userEvent.click(correctionEntryPage.getCellClear(3));
    expect(correctionEntryPage.getCell(3)).toHaveTextContent("—");
    // Its ✕ is gone now that the slot is empty.
    expect(correctionEntryPage.queryCellClear(3)).toBeNull();

    // In-pad Clear empties the open game (game 1).
    await userEvent.click(correctionEntryPage.getClear());
    expect(correctionEntryPage.getInput("rita.kovac")).toHaveValue("");
    expect(correctionEntryPage.getCell(1)).toHaveTextContent("—");
  });

  it("advances to the next game when Enter is pressed on the opponent field", async () => {
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(buildCorrectableMatch()),
    );
    correctionEntryPage.render();

    const opp1 = await waitFor(() => correctionEntryPage.getInput("leo.mertens"));
    opp1.focus();
    await userEvent.keyboard("{Enter}");

    // Game 2 is now the open, active cell — the pad shows its 11–6 score.
    await waitFor(() =>
      expect(correctionEntryPage.getActiveCell()).toBe(
        correctionEntryPage.getCell(2),
      ),
    );
    expect(correctionEntryPage.getInput("leo.mertens")).toHaveValue("6");
  });

  it('fires a single POST /results when "Send corrected score" is double-clicked in one frame (#737)', async () => {
    // Mirrors score-entry's #641 regression test: a fast double-tap lands a
    // second click before React commits the button's `disabled` re-render, so
    // only the synchronous in-flight ref (not `proposeMutation.isPending`
    // alone) can swallow the second tap. Two *synchronous* fireEvent clicks
    // reproduce the same-frame race (awaited user-event clicks would let the
    // `disabled` attr alone block the second, hiding the regression).
    let requests = 0;
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(buildCorrectableMatch()),
    );
    correctionEntryPage.mockPropose(() => {
      requests += 1;
      // Never resolves — keeps the propose in flight so the test can count
      // the POSTs the double-click produced.
      return new Promise<never>(() => {});
    });
    correctionEntryPage.render();

    await waitFor(() => correctionEntryPage.getInput("rita.kovac"));

    const submit = correctionEntryPage.getSubmit();
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(submit).toBeDisabled());
    expect(requests).toBe(1);
  });

  it("surfaces a 409 (the proposal moved on) inline without navigating away", async () => {
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(buildCorrectableMatch()),
    );
    correctionEntryPage.mockPropose(() =>
      HttpResponse.json(
        { detail: "The standing result has moved on." },
        { status: 409 },
      ),
    );
    correctionEntryPage.render();

    await waitFor(() => correctionEntryPage.getInput("rita.kovac"));
    await userEvent.click(correctionEntryPage.getSubmit());

    await waitFor(() =>
      expect(
        correctionEntryPage
          .queryAlerts()
          .some((a: HTMLElement) => /moved on/i.test(a.textContent ?? "")),
      ).toBe(true),
    );
    expect(correctionEntryPage.queryMatchLanding()).not.toBeInTheDocument();
  });

  it("surfaces a transport-level failure inline and leaves Send retryable, on a valid decided board (#839)", async () => {
    // `useProposeResult` runs `networkMode: 'always'`, so an offline submit
    // fires the POST and `fetch` rejects with a plain `TypeError` — NOT an
    // `ApiError`. On a valid, decided board (no `boardHint`) the old code
    // rendered nothing here, leaving the user with zero feedback. The board
    // below is the seed's untouched decided 3–0, so only the connection alert
    // can explain the failure.
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(buildCorrectableMatch()),
    );
    correctionEntryPage.mockPropose(() => HttpResponse.error());
    correctionEntryPage.render();

    await waitFor(() => correctionEntryPage.getInput("rita.kovac"));
    await userEvent.click(correctionEntryPage.getSubmit());

    // Wait on the mutation *settling*, not on the alert — the button returning
    // from "Sending…" to enabled happens in BOTH the fixed and broken states,
    // so this resolves in ~milliseconds either way. If we waited on the alert
    // itself, a regression (no alert) would red as an opaque 5s timeout
    // (`asyncUtilTimeout` == `testTimeout` == 5000, so a missing signal is
    // indistinguishable from a hang). Settling first, then asserting the alert
    // synchronously, makes a missing alert fail fast with a crisp query error.
    await waitFor(() => {
      expect(correctionEntryPage.getSubmit()).toBeEnabled();
      expect(correctionEntryPage.getSubmit()).toHaveTextContent(
        "Send corrected score",
      );
    });

    // Now the connection alert MUST already be in the DOM (it renders in the
    // same commit the mutation error settled). Assert it synchronously so its
    // absence is an immediate "unable to find role alert", not a timeout.
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Couldn't send your corrected score .* check your connection and try again/i,
    );
    // The board never left, so no navigation — and the re-enabled button above
    // means the user can retry (not stuck on "Sending…").
    expect(correctionEntryPage.queryMatchLanding()).not.toBeInTheDocument();
  });

  it("re-fires the POST when Send is clicked again while still offline (#839 retry)", async () => {
    // After a transport-level failure, `onError` resets the synchronous
    // `submittingRef` guard, so a second Send must actually re-fire the mutation
    // — it must not be dead-locked by a ref that never cleared. Both submits
    // fail (still offline), so counting the POSTs in the handler proves the
    // retry left the boundary rather than being swallowed client-side.
    let requests = 0;
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(buildCorrectableMatch()),
    );
    correctionEntryPage.mockPropose(() => {
      requests += 1;
      return HttpResponse.error();
    });
    correctionEntryPage.render();

    await waitFor(() => correctionEntryPage.getInput("rita.kovac"));

    // First send fails at the transport level → the connection alert renders and
    // the button settles back from "Sending…" to enabled. Wait on the settle
    // (a both-states signal), then assert the alert synchronously so a missing
    // alert fails crisply rather than as an opaque 5s timeout.
    await userEvent.click(correctionEntryPage.getSubmit());
    await waitFor(() => {
      expect(correctionEntryPage.getSubmit()).toBeEnabled();
      expect(correctionEntryPage.getSubmit()).toHaveTextContent(
        "Send corrected score",
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Couldn't send your corrected score .* check your connection and try again/i,
    );

    // Retry: click Send again. In the working case the button goes disabled
    // ("Sending…") then re-enables when the second failure settles, so
    // `waitFor(enabled)` genuinely waits for that round-trip and `requests` is
    // already 2 by the time it resolves. If the retry were dead-locked by a
    // stuck `submittingRef`, the button never leaves "Send corrected score" and
    // the synchronous `requests` assertion fails with "expected 1 to be 2" —
    // not a timeout.
    await userEvent.click(correctionEntryPage.getSubmit());
    await waitFor(() => {
      expect(correctionEntryPage.getSubmit()).toBeEnabled();
      expect(correctionEntryPage.getSubmit()).toHaveTextContent(
        "Send corrected score",
      );
    });
    expect(requests).toBe(2);

    // The alert is still up, nothing is stuck on "Sending…", and the board
    // never navigated away.
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Couldn't send your corrected score .* check your connection and try again/i,
    );
    expect(correctionEntryPage.queryMatchLanding()).not.toBeInTheDocument();
  });

  it("recovers on retry after reconnecting: a second Send succeeds and navigates (#839 reconnect)", async () => {
    // First submit fails at the transport level (offline), rendering the
    // connection alert. Once the endpoint recovers, a second Send must succeed
    // and navigate to the match-detail landing — the failure must not leave the
    // flow wedged. The success also resets the mutation error, so the stale
    // connection alert must not linger.
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(buildCorrectableMatch()),
    );
    correctionEntryPage.mockPropose(() => HttpResponse.error());
    correctionEntryPage.render();

    await waitFor(() => correctionEntryPage.getInput("rita.kovac"));

    // First send fails offline: settle back to enabled, then assert the alert
    // synchronously (crisp fail if it never rendered).
    await userEvent.click(correctionEntryPage.getSubmit());
    await waitFor(() => {
      expect(correctionEntryPage.getSubmit()).toBeEnabled();
      expect(correctionEntryPage.getSubmit()).toHaveTextContent(
        "Send corrected score",
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Couldn't send your corrected score .* check your connection and try again/i,
    );

    // Reconnect: the endpoint now succeeds. `server.use` prepends, so this
    // handler wins for the retry.
    correctionEntryPage.mockPropose(() =>
      HttpResponse.json(buildMatchDetails(), { status: 201 }),
    );

    // Retry → success navigates to the match-detail landing (same pattern the
    // success test above asserts).
    await userEvent.click(correctionEntryPage.getSubmit());
    await waitFor(() =>
      expect(correctionEntryPage.queryMatchLanding()).toBeInTheDocument(),
    );

    // The success path does not keep showing the stale connection alert.
    expect(
      correctionEntryPage
        .queryAlerts()
        .some((a: HTMLElement) =>
          /check your connection/i.test(a.textContent ?? ""),
        ),
    ).toBe(false);
  });

  it("redirects to match details instead of rendering when the match is already settled (#730)", async () => {
    // A finalized match still carries a `standing_result` (the settled score),
    // so the redirect must key off `viewer_state`, not just the presence of a
    // standing result. Direct-nav to /results/new on such a match must bounce
    // back to the (locked) match-detail page instead of rendering a live,
    // submittable correction editor.
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(
        buildCorrectableMatch({
          negotiation: {
            viewer_state: "final",
            your_turn: false,
            standing_result: buildStandingResult(),
            prior_result: null,
            diff: null,
          },
        }),
      ),
    );
    correctionEntryPage.render();

    await waitFor(() =>
      expect(correctionEntryPage.queryMatchLanding()).toBeInTheDocument(),
    );
  });

  it("still renders for the viewer's own pending proposal (awaiting), reachable via match-detail's Edit result action", async () => {
    // `awaiting` also has `your_turn: false` (it's the opponent's move, not
    // the viewer's), but unlike `final` it's a self-edit of the viewer's own
    // standing proposal, wired up via the match-detail "Edit result" link — so
    // the redirect guard must key specifically off `final`, not `your_turn`,
    // or this legitimate entry point breaks (regression check on the #730 fix).
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(
        buildCorrectableMatch({
          negotiation: {
            viewer_state: "awaiting",
            your_turn: false,
            standing_result: buildStandingResult(),
            prior_result: null,
            diff: null,
          },
        }),
      ),
    );
    correctionEntryPage.render();

    await waitFor(() =>
      expect(correctionEntryPage.getInput("rita.kovac")).toHaveValue("11"),
    );
    expect(correctionEntryPage.queryMatchLanding()).not.toBeInTheDocument();
    // A self-edit isn't "correcting" anyone — the copy reads as an edit, not a
    // correction (the entry link that reaches this state says "Edit result").
    expect(
      screen.getByRole("heading", { name: "Edit your result." }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Suggest a correction." }),
    ).not.toBeInTheDocument();
    expect(correctionEntryPage.getSubmit()).toHaveTextContent(
      "Send updated score",
    );
    // The browser tab title must match the heading, not leak the opponent-facing
    // "Suggest a correction" wording the shared route defaults to (C1 QA leak).
    await waitFor(() =>
      expect(document.title).toBe("Edit your result · FortyMM"),
    );
  });

  it("titles the tab 'Suggest a correction' when reacting to the opponent's proposal", async () => {
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(
        buildCorrectableMatch({
          negotiation: {
            viewer_state: "review",
            your_turn: true,
            standing_result: buildStandingResult(),
            prior_result: null,
            diff: null,
          },
        }),
      ),
    );
    correctionEntryPage.render();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Suggest a correction." }),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(document.title).toBe("Suggest a correction · FortyMM"),
    );
  });
});
