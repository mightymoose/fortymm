import { HttpResponse } from "msw";

import { ApiError } from "@/api/client";
import {
  buildMatchDetails,
  buildMatchDetailsPlayer,
  buildMatchDetailsSide,
} from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { matchDetailsQuery } from "../match-details-query";
import { scoreboardQuery } from "./scoreboard-query";
import { scoreboardQueryPage } from "./scoreboard-query.page";

describe("scoreboardQuery", () => {
  it("builds the outcome from the winning and losing sides", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide({
              won: true,
              games_won: 3,
              players: [buildMatchDetailsPlayer({ username: "rita.kovac" })],
            }),
            buildMatchDetailsSide({
              side_number: 2,
              won: false,
              games_won: 1,
              players: [buildMatchDetailsPlayer({ username: "leo.mertens" })],
            }),
          ],
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome).toBe(
      "rita.kovac defeated leo.mertens, 3 games to 1",
    );
  });

  it("uses the singular 'game' when the winner has won exactly one", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide({
              won: true,
              games_won: 1,
              players: [buildMatchDetailsPlayer({ username: "rita.kovac" })],
            }),
            buildMatchDetailsSide({
              side_number: 2,
              won: false,
              games_won: 0,
              players: [buildMatchDetailsPlayer({ username: "leo.mertens" })],
            }),
          ],
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome).toBe(
      "rita.kovac defeated leo.mertens, 1 game to 0",
    );
  });

  it.each(["scheduled", "live", "final"] as const)(
    "passes through data.scoreboard.status (%s)",
    async (status) => {
      scoreboardQueryPage.mockEndpoint(() =>
        HttpResponse.json(buildMatchDetails({ data: { scoreboard: { status } } })),
      );

      const { result } = scoreboardQueryPage.render();

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.status).toBe(status);
    },
  );

  it("projects an upcoming chip from status_label for a scheduled match, with no race label", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          status_label: "Awaiting opponent",
          data: { scoreboard: { status: "scheduled" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heading).toEqual({
      chip: { status: "scheduled", label: "Awaiting opponent" },
      formatLabel: "SINGLES · BO5",
      raceLabel: null,
    });
  });

  it("projects a live chip naming the current game, and the race label", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          current_game: { game_number: 3 },
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heading.chip).toEqual({
      status: "live",
      label: "Live · Game 3",
    });
    expect(result.current.data?.heading.raceLabel).toBe("First to 3");
  });

  it("projects no chip for a live match with no current game", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          current_game: null,
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heading.chip).toBeNull();
  });

  it("projects a Final chip for a final match", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ data: { scoreboard: { status: "final" } } }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heading.chip).toEqual({
      status: "final",
      label: "Final",
    });
  });

  it("builds the format label from team_size and best_of", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ team_size: 2, best_of: 3, games_to_win: 2 }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heading.formatLabel).toBe("DOUBLES · BO3");
  });

  it("builds the race label from games_to_win", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          best_of: 1,
          games_to_win: 1,
          data: { scoreboard: { status: "final" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heading.raceLabel).toBe("First to 1");
  });

  it("reports no games recorded for a match that has not started", async () => {
    // The default factory leaves both sides at `won: null`, `games_won: 0`.
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails()),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome).toBe(
      "rita.kovac and leo.mertens have not started yet",
    );
  });

  it("describes a tied match in progress", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide({
              games_won: 2,
              players: [buildMatchDetailsPlayer({ username: "rita.kovac" })],
            }),
            buildMatchDetailsSide({
              side_number: 2,
              games_won: 2,
              players: [buildMatchDetailsPlayer({ username: "leo.mertens" })],
            }),
          ],
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome).toBe(
      "rita.kovac and leo.mertens are tied, 2 games all",
    );
  });

  it("describes the leading side in a match in progress", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide({
              games_won: 1,
              players: [buildMatchDetailsPlayer({ username: "rita.kovac" })],
            }),
            buildMatchDetailsSide({
              side_number: 2,
              games_won: 2,
              players: [buildMatchDetailsPlayer({ username: "leo.mertens" })],
            }),
          ],
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome).toBe("leo.mertens leading, 2 games to 1");
  });

  it("treats a side still on zero as leading, not unstarted, when the other has won games", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide({
              games_won: 0,
              players: [buildMatchDetailsPlayer({ username: "rita.kovac" })],
            }),
            buildMatchDetailsSide({
              side_number: 2,
              games_won: 2,
              players: [buildMatchDetailsPlayer({ username: "leo.mertens" })],
            }),
          ],
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome).toBe("leo.mertens leading, 2 games to 0");
  });

  it("falls back to in-progress copy when one side is won but the other is not yet lost", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide({
              won: true,
              games_won: 3,
              players: [buildMatchDetailsPlayer({ username: "rita.kovac" })],
            }),
            // `won` left at its `null` default — there is no losing side to pair.
            buildMatchDetailsSide({
              side_number: 2,
              games_won: 1,
              players: [buildMatchDetailsPlayer({ username: "leo.mertens" })],
            }),
          ],
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome).toBe("rita.kovac leading, 3 games to 1");
  });

  it("returns a null outcome when a side is missing entirely", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ sides: [buildMatchDetailsSide()] })),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome).toBeNull();
  });

  it("returns a null outcome when there are no sides at all", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ sides: [] })),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome).toBeNull();
  });

  it("returns a null outcome when the winning side has no players", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide({ won: true, games_won: 3, players: [] }),
            buildMatchDetailsSide({
              side_number: 2,
              won: false,
              games_won: 1,
              players: [buildMatchDetailsPlayer({ username: "leo.mertens" })],
            }),
          ],
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome).toBeNull();
  });

  it("uses in-progress copy when there is no won === true / won === false pair", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide({
              won: false,
              games_won: 1,
              players: [buildMatchDetailsPlayer({ username: "rita.kovac" })],
            }),
            buildMatchDetailsSide({
              side_number: 2,
              won: false,
              games_won: 0,
              players: [buildMatchDetailsPlayer({ username: "leo.mertens" })],
            }),
          ],
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // No side `won: true`, so it is not "defeated" — just the current lead.
    expect(result.current.data?.outcome).toBe("rita.kovac leading, 1 game to 0");
  });

  it("surfaces an error when data.scoreboard.status fails validation", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          data: { scoreboard: { status: "not-a-real-status" as never } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("surfaces an ApiError when the request fails", async () => {
    scoreboardQueryPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(500);
  });

  it("shares the matchDetailsQuery cache key so the request is not duplicated", () => {
    expect(scoreboardQuery("m-1").queryKey).toEqual(
      matchDetailsQuery("m-1").queryKey,
    );
  });
});
