import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsGame,
  buildMatchDetailsScore,
  type MatchDetails,
} from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { finalizeCalloutQuery } from "./finalize-callout-query";
import { finalizeCalloutQueryPage } from "./finalize-callout-query.page";

/** A decided-but-unposted board: two saved 11-x wins for side 1 (delivered
 * out of game order, with an unscored game 3 in between), `can_finalize` on. */
const finalizableMatch = (overrides: Partial<MatchDetails> = {}): MatchDetails =>
  buildMatchDetails({
    can_finalize: true,
    games: [
      buildMatchDetailsGame({
        id: "g2",
        game_number: 2,
        score: buildMatchDetailsScore({
          id: "s2",
          side_1_points: 11,
          side_2_points: 7,
        }),
      }),
      buildMatchDetailsGame({ id: "g3", game_number: 3 }),
      buildMatchDetailsGame({
        id: "g1",
        game_number: 1,
        score: buildMatchDetailsScore({
          id: "s1",
          side_1_points: 11,
          side_2_points: 4,
        }),
      }),
    ],
    ...overrides,
  });

const renderView = async () => {
  const { result } = finalizeCalloutQueryPage.render();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result;
};

describe("finalizeCalloutQuery", () => {
  it("shares the match-details query key so the page's BFF fetch is reused", () => {
    expect(finalizeCalloutQuery("m-1").queryKey).toEqual([
      { scope: "matches", version: "v1", entity: "details", matchId: "m-1" },
    ]);
  });

  it("projects the saved scores as canonical write payloads, scored games only, in game order", async () => {
    finalizeCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(finalizableMatch()),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({
      games: [
        { game_number: 1, side_1_points: 11, side_2_points: 4 },
        { game_number: 2, side_1_points: 11, side_2_points: 7 },
      ],
    });
  });

  it("projects null when the board isn't finalizable, even with saved scores", async () => {
    finalizeCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(finalizableMatch({ can_finalize: false })),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });
});
