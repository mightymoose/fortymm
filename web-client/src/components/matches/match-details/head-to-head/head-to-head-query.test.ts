import { HttpResponse } from "msw";

import { fmtDateShort } from "@/lib/dates";
import {
  buildMatchDetails,
  buildMatchDetailsH2H,
  buildMatchDetailsH2HMeeting,
  buildMatchDetailsPlayer,
  buildMatchDetailsSide,
  type MatchDetails,
} from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { headToHeadQuery } from "./head-to-head-query";
import { headToHeadQueryPage } from "./head-to-head-query.page";

/** rita.kovac (viewer, side 1) vs leo.mertens (side 2), side 1 leading 2–1
 * with one recent meeting (a 3–2 side-1 win). */
const matchWithH2H = (overrides: Partial<MatchDetails> = {}): MatchDetails =>
  buildMatchDetails({ head_to_head: buildMatchDetailsH2H(), ...overrides });

const renderH2H = async (matchId?: string) => {
  const { result } = headToHeadQueryPage.render(matchId);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result;
};

describe("headToHeadQuery", () => {
  it("shares the match-details query key so the page's BFF fetch is reused", () => {
    expect(headToHeadQuery("m-1").queryKey).toEqual([
      { scope: "matches", version: "v1", entity: "details", matchId: "m-1" },
    ]);
  });

  it("projects viewer-first counts and meetings with a formatted date", async () => {
    headToHeadQueryPage.mockEndpoint(() => HttpResponse.json(matchWithH2H()));

    const result = await renderH2H();

    expect(result.current.data).toEqual({
      leftLabel: "rita.kovac",
      rightLabel: "leo.mertens",
      totalMeetings: 3,
      leftWins: 2,
      rightWins: 1,
      recentMeetings: [
        {
          matchId: "m-h2h-1",
          dateLabel: fmtDateShort("2026-05-08T18:00:00Z"),
          leftGamesWon: 3,
          rightGamesWon: 2,
          leftWon: true,
        },
      ],
    });
  });

  it("swaps counts, scores and the win flag when the viewer is on side 2", async () => {
    // side 1 is the opponent, side 2 is the viewer — left should anchor on the
    // viewer's side 2, flipping every side-1/side-2 figure.
    headToHeadQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        matchWithH2H({
          sides: [
            buildMatchDetailsSide({
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-opponent",
                  username: "leo.mertens",
                  is_current_user: false,
                }),
              ],
              is_current_user_side: false,
            }),
            buildMatchDetailsSide({ side_number: 2, is_current_user_side: true }),
          ],
        }),
      ),
    );

    const result = await renderH2H();

    expect(result.current.data).toMatchObject({
      leftLabel: "rita.kovac",
      rightLabel: "leo.mertens",
      leftWins: 1,
      rightWins: 2,
      recentMeetings: [
        { leftGamesWon: 2, rightGamesWon: 3, leftWon: false },
      ],
    });
  });

  it("is null when the match carries no head-to-head record", async () => {
    headToHeadQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails()),
    );

    const result = await renderH2H();

    expect(result.current.data).toBeNull();
  });

  it("keeps the card for a fresh rivalry with no prior meetings", async () => {
    headToHeadQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        matchWithH2H({
          head_to_head: buildMatchDetailsH2H({
            total_meetings: 0,
            side_1_wins: 0,
            side_2_wins: 0,
            recent_meetings: [],
          }),
        }),
      ),
    );

    const result = await renderH2H();

    expect(result.current.data).toMatchObject({
      totalMeetings: 0,
      leftWins: 0,
      rightWins: 0,
      recentMeetings: [],
    });
  });

  it("keeps meetings newest-first in payload order", async () => {
    headToHeadQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        matchWithH2H({
          head_to_head: buildMatchDetailsH2H({
            recent_meetings: [
              buildMatchDetailsH2HMeeting({ match_id: "m-new" }),
              buildMatchDetailsH2HMeeting({ match_id: "m-old" }),
            ],
          }),
        }),
      ),
    );

    const result = await renderH2H();

    expect(result.current.data?.recentMeetings.map((m) => m.matchId)).toEqual([
      "m-new",
      "m-old",
    ]);
  });

  it("labels the viewer's playerless side You and the empty opponent Opponent", async () => {
    headToHeadQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        matchWithH2H({
          sides: [
            buildMatchDetailsSide({ players: [], is_current_user_side: true }),
            buildMatchDetailsSide({
              side_number: 2,
              players: [],
              is_current_user_side: false,
            }),
          ],
        }),
      ),
    );

    const result = await renderH2H();

    expect(result.current.data).toMatchObject({
      leftLabel: "You",
      rightLabel: "Opponent",
    });
  });

  it("labels playerless sides Side 1 / Side 2 for a non-participant viewer", async () => {
    headToHeadQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        matchWithH2H({
          sides: [
            buildMatchDetailsSide({ players: [], is_current_user_side: false }),
            buildMatchDetailsSide({
              side_number: 2,
              players: [],
              is_current_user_side: false,
            }),
          ],
        }),
      ),
    );

    const result = await renderH2H();

    expect(result.current.data).toMatchObject({
      leftLabel: "Side 1",
      rightLabel: "Side 2",
    });
  });

  it("falls back to Opponent when the match has no right side", async () => {
    headToHeadQueryPage.mockEndpoint(() =>
      HttpResponse.json(matchWithH2H({ sides: [buildMatchDetailsSide()] })),
    );

    const result = await renderH2H();

    expect(result.current.data).toMatchObject({
      leftLabel: "rita.kovac",
      rightLabel: "Opponent",
    });
  });

  it("orders side 1 left for a non-participant viewer regardless of payload order", async () => {
    headToHeadQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        matchWithH2H({
          sides: [
            buildMatchDetailsSide({
              side_number: 2,
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-two",
                  username: "side.two",
                  is_current_user: false,
                }),
              ],
              is_current_user_side: false,
            }),
            buildMatchDetailsSide({
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-one",
                  username: "side.one",
                  is_current_user: false,
                }),
              ],
              is_current_user_side: false,
            }),
          ],
        }),
      ),
    );

    const result = await renderH2H();

    expect(result.current.data).toMatchObject({
      leftLabel: "side.one",
      rightLabel: "side.two",
    });
  });
});
