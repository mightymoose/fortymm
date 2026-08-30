import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsPlayer,
  buildMatchDetailsSide,
} from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { scoreCtaQueryPage } from "./score-cta-query.page";

describe("scoreCtaQuery", () => {
  it("projects the match id and current game when the viewer can score", async () => {
    scoreCtaQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          id: "m-9",
          can_score: true,
          current_game: { game_number: 2 },
        }),
      ),
    );

    const { result } = scoreCtaQueryPage.render();

    await waitFor(() => expect(result.current.data).not.toBeUndefined());
    expect(result.current.data).toEqual({ matchId: "m-9", gameNumber: 2 });
  });

  it("projects the CTA for a director who can score but holds no side (#1523)", async () => {
    // `can_score` widens to true for the tournament director on a called,
    // unresolved match in their own tournament, even when they aren't a
    // participant — no side carries `is_current_user_side: true`. The
    // selector only reads `can_score` + `current_game`, so this should
    // already work; this test verifies that rather than assuming it.
    scoreCtaQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          id: "m-director",
          can_score: true,
          current_game: { game_number: 2 },
          sides: [
            buildMatchDetailsSide({
              is_current_user_side: false,
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-a",
                  username: "alice",
                  is_current_user: false,
                }),
              ],
            }),
            buildMatchDetailsSide({
              side_number: 2,
              is_current_user_side: false,
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-b",
                  username: "bob",
                  is_current_user: false,
                }),
              ],
            }),
          ],
        }),
      ),
    );

    const { result } = scoreCtaQueryPage.render();

    await waitFor(() => expect(result.current.data).not.toBeUndefined());
    expect(result.current.data).toEqual({ matchId: "m-director", gameNumber: 2 });
  });

  it("projects null when the viewer cannot score", async () => {
    scoreCtaQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          can_score: false,
          current_game: { game_number: 2 },
        }),
      ),
    );

    const { result } = scoreCtaQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("projects null when there is no current game to score", async () => {
    scoreCtaQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ can_score: true, current_game: null }),
      ),
    );

    const { result } = scoreCtaQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});
