import { HttpResponse } from "msw";

import { ApiError } from "@/api/client";
import {
  buildMatchDetails,
  buildMatchDetailsGame,
  buildMatchDetailsPlayer,
  buildMatchDetailsScore,
  buildMatchDetailsSide,
} from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { matchDetailsQuery } from "../../match-details-query";
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
      "rita.kovac defeated leo.mertens by 3 games to 1",
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
      "rita.kovac defeated leo.mertens by 1 game to 0",
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

  it("falls back to the status label as the chip for a live match with no current game (#492)", async () => {
    // A posted-but-unconfirmed board is `live` with no current game; the chip
    // must still show the server's label rather than vanishing.
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          status_label: "Awaiting acceptance",
          current_game: null,
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heading.chip).toEqual({
      status: "live",
      label: "Awaiting acceptance",
    });
  });

  it("projects a Final chip for a final match", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          status_label: "Final",
          data: { scoreboard: { status: "final" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heading.chip).toEqual({
      status: "final",
      label: "Final",
    });
  });

  it("projects the server's status label, not 'Final', when the coarse status is final (#561)", async () => {
    // Some boards map to the coarse `final` scoreboard status while carrying a
    // more specific lifecycle label; the chip must read the server's label so
    // it agrees with the Match-info Status field.
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          status_label: "In review",
          data: { scoreboard: { status: "final" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heading.chip).toEqual({
      status: "final",
      label: "In review",
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
          best_of: 3,
          games_to_win: 2,
          data: { scoreboard: { status: "final" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heading.raceLabel).toBe("First to 2");
  });

  it("projects a best-of-1 match as a single game: SINGLE label, no race, no grid", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          best_of: 1,
          games_to_win: 1,
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heading.formatLabel).toBe("SINGLES · SINGLE");
    expect(result.current.data?.heading.raceLabel).toBeNull();
    // The single-game grid is suppressed via the flag the display reads.
    expect(result.current.data?.showGameGrid).toBe(false);
  });

  it("labels a best-of-1 team match DOUBLES · SINGLE", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ team_size: 2, best_of: 1, games_to_win: 1 }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heading.formatLabel).toBe("DOUBLES · SINGLE");
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
      "rita.kovac and leo.mertens are tied at 2 games apiece",
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
    expect(result.current.data?.outcome).toBe("leo.mertens leads by 2 games to 1");
  });

  it("describes a posted result awaiting acceptance as won, not leading (#491)", async () => {
    // The board is decided (a result was posted) but `side.won` is still null
    // until the other side confirms. The outcome must read "won … awaiting
    // confirmation", not "leading", which implies play continues.
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          status_label: "Awaiting acceptance",
          current_game: null,
          data: { scoreboard: { status: "live" } },
          sides: [
            buildMatchDetailsSide({
              games_won: 3,
              players: [buildMatchDetailsPlayer({ username: "rita.kovac" })],
            }),
            buildMatchDetailsSide({
              side_number: 2,
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
      "rita.kovac won 3 games to 0 — awaiting acceptance",
    );
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
    expect(result.current.data?.outcome).toBe("leo.mertens leads by 2 games to 0");
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
    expect(result.current.data?.outcome).toBe("rita.kovac leads by 3 games to 1");
  });

  it("names the finishing player for a finished solo (no-opponent) match (#495)", async () => {
    // A solo match has one played side stamped `won: true` and a playerless
    // ghost opponent side; there is no losing player to pair, so the heading
    // used to fall through to the null guard and read just "Match".
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          status_label: "Final",
          sides: [
            buildMatchDetailsSide({
              won: true,
              games_won: 3,
              players: [buildMatchDetailsPlayer({ username: "rita.kovac" })],
            }),
            buildMatchDetailsSide({
              side_number: 2,
              won: false,
              games_won: 0,
              players: [],
              is_current_user_side: false,
            }),
          ],
          data: { scoreboard: { status: "final" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome).toBe(
      "rita.kovac finished, winning 3 games to 0",
    );
  });

  it("counts the games the ghost side won in a finished solo match (MA4)", async () => {
    // In solo play the playerless ghost side can still take individual games, so
    // it carries `won: false` with a non-zero games_won. The heading must report
    // that tally rather than hardcoding "to 0", which dropped the ghost's wins.
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          status_label: "Final",
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
              players: [],
              is_current_user_side: false,
            }),
          ],
          data: { scoreboard: { status: "final" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome).toBe(
      "rita.kovac finished, winning 3 games to 1",
    );
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
    expect(result.current.data?.outcome).toBe("rita.kovac leads by 1 game to 0");
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

  it("projects no game grid for a scheduled match", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ data: { scoreboard: { status: "scheduled" } } }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.gameGrid).toBeNull();
  });

  it("projects no game grid when the match has only one side", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [buildMatchDetailsSide()],
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.gameGrid).toBeNull();
  });

  it("projects scored cells per side, padded to best_of, with the match id", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          id: "m-99",
          best_of: 5,
          can_score: true,
          games: [
            buildMatchDetailsGame({
              score: buildMatchDetailsScore({
                side_1_points: 11,
                side_2_points: 7,
              }),
            }),
            buildMatchDetailsGame({ id: "g-2", game_number: 2 }),
          ],
          current_game: { game_number: 2 },
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const grid = result.current.data?.gameGrid;
    expect(grid?.matchId).toBe("m-99");
    expect(grid?.bestOf).toBe(5);
    const [mine, theirs] = grid!.rows;
    expect(mine.cells).toHaveLength(5);
    expect(mine.cells[0]).toEqual({
      kind: "scored",
      points: 11,
      won: true,
      editGameNumber: 1,
    });
    // The opponent's row mirrors the score but never carries an edit link.
    expect(theirs.cells[0]).toEqual({
      kind: "scored",
      points: 7,
      won: false,
      editGameNumber: null,
    });
    // The existing-but-unscored current game is live; the padded slots aren't.
    expect(mine.cells[1]).toEqual({ kind: "unplayed", isLive: true });
    expect(mine.cells[2]).toEqual({ kind: "unplayed", isLive: false });
  });

  it("marks only the current game's unscored record live, not other unscored records", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          best_of: 5,
          games: [
            buildMatchDetailsGame({ id: "g-2", game_number: 2 }),
            buildMatchDetailsGame({ id: "g-3", game_number: 3 }),
          ],
          current_game: { game_number: 3 },
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [mine] = result.current.data!.gameGrid!.rows;
    expect(mine.cells[1]).toEqual({ kind: "unplayed", isLive: false });
    expect(mine.cells[2]).toEqual({ kind: "unplayed", isLive: true });
  });

  it("projects row identity and totals from the sides", async () => {
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
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-opp",
                  username: "leo.mertens",
                  is_current_user: false,
                }),
              ],
              is_current_user_side: false,
            }),
          ],
          data: { scoreboard: { status: "final" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [mine, theirs] = result.current.data!.gameGrid!.rows;
    expect(mine).toMatchObject({
      name: "rita.kovac",
      initials: "RK",
      isGhost: false,
      won: true,
      gamesWon: 3,
    });
    expect(theirs).toMatchObject({
      name: "leo.mertens",
      won: false,
      gamesWon: 1,
    });
  });

  it("puts the viewer's side first even when they are side 2", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          can_score: true,
          sides: [
            buildMatchDetailsSide({
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-opp",
                  username: "leo.mertens",
                  is_current_user: false,
                }),
              ],
              is_current_user_side: false,
            }),
            buildMatchDetailsSide({
              side_number: 2,
              players: [buildMatchDetailsPlayer({ username: "rita.kovac" })],
            }),
          ],
          games: [
            buildMatchDetailsGame({
              score: buildMatchDetailsScore({
                side_1_points: 11,
                side_2_points: 7,
              }),
            }),
          ],
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [mine, theirs] = result.current.data!.gameGrid!.rows;
    // Side 2's points lead, and the viewer's row carries the edit link.
    expect(mine).toMatchObject({ name: "rita.kovac" });
    expect(mine.cells[0]).toMatchObject({ points: 7, editGameNumber: 1 });
    expect(theirs.cells[0]).toMatchObject({
      points: 11,
      editGameNumber: null,
    });
  });

  it("carries no edit link on the viewer's own scored cell once the board is locked (can_score false)", async () => {
    // A posted/confirmed result flips `can_score` to false: the scores can no
    // longer be edited, so the viewer's own cells must render as plain text
    // rather than links — otherwise they'd show a hand cursor on hover.
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          can_score: false,
          games: [
            buildMatchDetailsGame({
              score: buildMatchDetailsScore({
                side_1_points: 11,
                side_2_points: 7,
              }),
            }),
          ],
          data: { scoreboard: { status: "final" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [mine] = result.current.data!.gameGrid!.rows;
    expect(mine.cells[0]).toMatchObject({
      points: 11,
      editGameNumber: null,
    });
  });

  it("orders by side number with no edit links when the viewer is a spectator", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide({
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-a",
                  username: "ada.l",
                  is_current_user: false,
                }),
              ],
              is_current_user_side: false,
            }),
            buildMatchDetailsSide({
              side_number: 2,
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-b",
                  username: "bo.k",
                  is_current_user: false,
                }),
              ],
              is_current_user_side: false,
            }),
          ],
          games: [
            buildMatchDetailsGame({ score: buildMatchDetailsScore() }),
          ],
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [first, second] = result.current.data!.gameGrid!.rows;
    expect(first.name).toBe("ada.l");
    expect(second.name).toBe("bo.k");
    expect(first.cells[0]).toMatchObject({ editGameNumber: null });
    expect(second.cells[0]).toMatchObject({ editGameNumber: null });
  });

  it("projects a playerless side as a ghost 'No opponent' row", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide(),
            buildMatchDetailsSide({
              side_number: 2,
              players: [],
              is_current_user_side: false,
            }),
          ],
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [, ghost] = result.current.data!.gameGrid!.rows;
    expect(ghost).toMatchObject({ name: "No opponent", isGhost: true });
  });

  it("projects the hero scoreline from the perspective-ordered sides", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide({
              won: false,
              games_won: 1,
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-opponent",
                  username: "leo.mertens",
                  is_current_user: false,
                }),
              ],
              is_current_user_side: false,
            }),
            buildMatchDetailsSide({
              side_number: 2,
              won: true,
              games_won: 3,
              players: [buildMatchDetailsPlayer({ username: "rita.kovac" })],
            }),
          ],
          data: { scoreboard: { status: "final" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The viewer is side 2, so their side reads left.
    expect(result.current.data?.heroRow).toEqual({
      left: { name: "rita.kovac", initials: "RK", isGhost: false, won: true },
      score: {
        kind: "scoreline",
        left: { gamesWon: 3, won: true },
        right: { gamesWon: 1, won: false },
      },
      right: {
        name: "leo.mertens",
        initials: "LM",
        isGhost: false,
        won: false,
      },
    });
  });

  it("projects an upcoming VS block carrying the status label for a scheduled match", async () => {
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
    expect(result.current.data?.heroRow.score).toEqual({
      kind: "upcoming",
      statusLabel: "Awaiting opponent",
    });
    expect(result.current.data?.heroRow.left.name).toBe("rita.kovac");
    expect(result.current.data?.heroRow.right.name).toBe("leo.mertens");
  });

  // Regression test for #394: a live match whose first game is still being
  // played (no completed game yet) must show the 0 — 0 scoreline, not the
  // upcoming "VS" placeholder — that state disagreed with the Live chip.
  it("projects a 0-0 scoreline, not the VS block, for a live match with no scored game", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          status: "in_progress",
          games: [buildMatchDetailsGame()],
          current_game: { game_number: 1 },
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heroRow.score).toEqual({
      kind: "scoreline",
      left: { gamesWon: 0, won: false },
      right: { gamesWon: 0, won: false },
    });
  });

  it("projects a ghost hero side scoring zero when the match has only one side", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [buildMatchDetailsSide({ games_won: 2 })],
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heroRow.right).toEqual({
      name: "No opponent",
      initials: "NO",
      isGhost: true,
      won: false,
    });
    expect(result.current.data?.heroRow.score).toEqual({
      kind: "scoreline",
      left: { gamesWon: 2, won: false },
      right: { gamesWon: 0, won: false },
    });
  });

  it("projects a playerless side as a ghost hero side", async () => {
    scoreboardQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide(),
            buildMatchDetailsSide({
              side_number: 2,
              players: [],
              is_current_user_side: false,
            }),
          ],
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    const { result } = scoreboardQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.heroRow.right).toMatchObject({
      name: "No opponent",
      isGhost: true,
    });
  });

  it("shares the matchDetailsQuery cache key so the request is not duplicated", () => {
    expect(scoreboardQuery("m-1").queryKey).toEqual(
      matchDetailsQuery("m-1").queryKey,
    );
  });
});
