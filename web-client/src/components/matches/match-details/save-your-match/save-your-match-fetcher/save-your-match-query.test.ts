import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsPlayer,
  buildMatchDetailsSide,
  type MatchDetails,
} from "@/mocks/factories/matches/match-details.factory";
import {
  buildMatchDetailsData,
  buildScoreboard,
} from "@/mocks/factories/matches/scoreboard.factory";
import { waitFor } from "@/test/utilities";

import { saveYourMatchQuery } from "./save-your-match-query";
import { saveYourMatchQueryPage } from "./save-your-match-query.page";

/** A live match with the viewer (rita.kovac, side 1) up 3–1 on leo.mertens —
 * the canonical "save this match" candidate. */
const liveMatch = (overrides: Partial<MatchDetails> = {}): MatchDetails =>
  buildMatchDetails({
    status: "in_progress",
    status_label: "Live",
    sides: [
      buildMatchDetailsSide({ games_won: 3, won: true }),
      buildMatchDetailsSide({
        side_number: 2,
        players: [
          buildMatchDetailsPlayer({
            user_id: "u-opponent",
            username: "leo.mertens",
            is_current_user: false,
          }),
        ],
        games_won: 1,
        won: false,
        is_current_user_side: false,
      }),
    ],
    data: buildMatchDetailsData({
      scoreboard: buildScoreboard({ status: "live" }),
    }),
    ...overrides,
  });

const renderView = async (matchId?: string) => {
  const { result } = saveYourMatchQueryPage.render(matchId);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result;
};

describe("saveYourMatchQuery", () => {
  it("shares the match-details query key so the page's BFF fetch is reused", () => {
    expect(saveYourMatchQuery("m-1").queryKey).toEqual([
      { scope: "matches", version: "v1", entity: "details", matchId: "m-1" },
    ]);
  });

  it("projects the viewer-first anchor with initials, scores, and createdAt", async () => {
    saveYourMatchQueryPage.mockEndpoint(() =>
      HttpResponse.json(liveMatch({ created_at: "2026-06-08T12:00:00Z" })),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({
      leftWon: true,
      leftInitials: "RK",
      leftGamesWon: 3,
      rightGamesWon: 1,
      rightInitials: "LM",
      rightUsername: "leo.mertens",
      createdAt: "2026-06-08T12:00:00Z",
      canConfirm: false,
    });
  });

  it("puts the viewer's side first even when they're side 2", async () => {
    saveYourMatchQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          status: "in_progress",
          status_label: "Live",
          sides: [
            buildMatchDetailsSide({
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-opponent",
                  username: "leo.mertens",
                  is_current_user: false,
                }),
              ],
              games_won: 1,
              won: false,
              is_current_user_side: false,
            }),
            buildMatchDetailsSide({
              side_number: 2,
              games_won: 3,
              won: true,
              is_current_user_side: true,
            }),
          ],
          data: buildMatchDetailsData({
            scoreboard: buildScoreboard({ status: "live" }),
          }),
        }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toMatchObject({
      leftInitials: "RK",
      leftGamesWon: 3,
      rightInitials: "LM",
      rightGamesWon: 1,
      rightUsername: "leo.mertens",
    });
  });

  it("surfaces canConfirm so the card can soften under the confirmation callout", async () => {
    saveYourMatchQueryPage.mockEndpoint(() =>
      HttpResponse.json(liveMatch({ can_confirm: true })),
    );

    const result = await renderView();

    expect(result.current.data?.canConfirm).toBe(true);
  });

  it("is null while the match is still scheduled — nothing to save yet", async () => {
    // The default factory match is scheduled (scoreboard status "scheduled").
    saveYourMatchQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails()),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });

  it("is null for a spectator who isn't a participant", async () => {
    const match = liveMatch();
    saveYourMatchQueryPage.mockEndpoint(() =>
      HttpResponse.json({
        ...match,
        sides: match.sides.map((s) => ({
          ...s,
          is_current_user_side: false,
          players: s.players.map((p) => ({ ...p, is_current_user: false })),
        })),
      }),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });

  it("is null when there's no real opponent (a player-less ghost side)", async () => {
    const match = liveMatch();
    saveYourMatchQueryPage.mockEndpoint(() =>
      HttpResponse.json({
        ...match,
        sides: match.sides.map((s) =>
          s.side_number === 2 ? { ...s, players: [] } : s,
        ),
      }),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });
});
