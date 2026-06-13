import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
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
