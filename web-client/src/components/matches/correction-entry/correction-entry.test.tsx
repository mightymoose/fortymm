import { HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import {
  STANDING_RESULT_ID,
  buildCorrectableMatch,
} from "./correction-entry.factory";
import { correctionEntryPage } from "./correction-entry.page";

describe("CorrectionEntry", () => {
  it("pre-fills the inputs from the standing-result snapshot (not the scratchpad)", async () => {
    // The seed's standing result is the opponent's 3–0 board (11–8, 11–6,
    // 11–9). The viewer is side 1 (rita.kovac), so the left field reads
    // side_1_points and the right reads side_2_points.
    correctionEntryPage.mockMatch(() =>
      HttpResponse.json(buildCorrectableMatch()),
    );
    correctionEntryPage.render();

    await waitFor(() =>
      expect(correctionEntryPage.getInput(1, "rita.kovac")).toHaveValue("11"),
    );
    expect(correctionEntryPage.getInput(1, "leo.mertens")).toHaveValue("8");
    expect(correctionEntryPage.getInput(2, "leo.mertens")).toHaveValue("6");
    expect(correctionEntryPage.getInput(3, "leo.mertens")).toHaveValue("9");
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

    // Correct game 3: the viewer says they actually won it 11–9 (flip the
    // opponent's 11–9). Edit the viewer's side from a blank.
    const me3 = await waitFor(() =>
      correctionEntryPage.getInput(3, "rita.kovac"),
    );
    await userEvent.clear(me3);
    await userEvent.type(me3, "11");
    const opp3 = correctionEntryPage.getInput(3, "leo.mertens");
    await userEvent.clear(opp3);
    await userEvent.type(opp3, "9");

    await userEvent.click(correctionEntryPage.getSubmit());

    await waitFor(() =>
      expect(postedBody).toEqual({
        supersedes_result_id: STANDING_RESULT_ID,
        games: [
          { game_number: 1, side_1_points: 11, side_2_points: 8 },
          { game_number: 2, side_1_points: 11, side_2_points: 6 },
          { game_number: 3, side_1_points: 11, side_2_points: 9 },
        ],
      }),
    );
    // On success the route navigates back to the match-details landing.
    await waitFor(() =>
      expect(correctionEntryPage.queryMatchLanding()).toBeInTheDocument(),
    );
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

    await waitFor(() => correctionEntryPage.getInput(1, "rita.kovac"));
    await userEvent.click(correctionEntryPage.getSubmit());

    await waitFor(() =>
      expect(
        correctionEntryPage
          .queryAlerts()
          .some((a: HTMLElement) => /moved on/i.test(a.textContent ?? "")),
      ).toBe(true),
    );
    // Still on the correction screen — no navigation on a rejected propose.
    expect(correctionEntryPage.queryMatchLanding()).not.toBeInTheDocument();
  });
});
