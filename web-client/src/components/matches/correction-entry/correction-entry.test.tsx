import { HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

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

  it("redirects to match details instead of rendering when the match is already settled (#730)", async () => {
    // A finalized match still carries a `standing_result` (the settled score),
    // so the redirect must key off `your_turn`, not just the presence of a
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
});
