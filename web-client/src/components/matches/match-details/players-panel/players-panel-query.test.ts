import { HttpResponse } from "msw";

import { fmtDateTimeShort } from "@/lib/dates";
import {
  buildMatchDetails,
  buildMatchDetailsFormResult,
  buildMatchDetailsPlayer,
  buildMatchDetailsPlayerForm,
  buildMatchDetailsSide,
} from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { playersPanelQuery } from "./players-panel-query";
import { playersPanelQueryPage } from "./players-panel-query.page";

const renderPanel = async (matchId?: string) => {
  const { result } = playersPanelQueryPage.render(matchId);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result;
};

describe("playersPanelQuery", () => {
  it("shares the match-details query key so the page's BFF fetch is reused", () => {
    expect(playersPanelQuery("m-1").queryKey).toEqual([
      { scope: "matches", version: "v1", entity: "details", matchId: "m-1" },
    ]);
  });

  it("stamps the snapshot label with the uppercased match creation time", async () => {
    playersPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ created_at: "2026-06-08T12:00:00Z" })),
    );

    const result = await renderPanel();

    // The timestamp half renders in the machine's local zone, so derive it
    // with the same formatter rather than hard-coding a TZ-fragile time.
    expect(result.current.data?.snapshotLabel).toBe(
      `SNAPSHOT · ${fmtDateTimeShort("2026-06-08T12:00:00Z").toUpperCase()}`,
    );
  });

  it("projects a player's identity, rating, form, and career from their form entry", async () => {
    playersPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          recent_form: [
            buildMatchDetailsPlayerForm({
              user_id: "u-me",
              rating_before: 1612.4,
              rating_history: [1580, 1601, 1612],
              career_matches_before: 12,
              career_wins_before: 9,
              recent_results: [
                buildMatchDetailsFormResult({
                  match_id: "m-prev-1",
                  is_win: true,
                  player_games_won: 3,
                  opponent_games_won: 1,
                  opponent_username: "silva.r",
                  completed_at: "2026-05-09T18:00:00Z",
                }),
                buildMatchDetailsFormResult({
                  match_id: "m-prev-2",
                  is_win: false,
                  player_games_won: 1,
                  opponent_games_won: 3,
                  opponent_username: "tanaka.y",
                  completed_at: "2026-05-07T18:00:00Z",
                }),
              ],
            }),
          ],
        }),
      ),
    );

    const result = await renderPanel();

    expect(result.current.data?.left).toEqual({
      name: "rita.kovac",
      initials: "RK",
      won: false,
      rating: { value: 1612, sparkline: [1580, 1601, 1612] },
      form: {
        kind: "history",
        kicker: "Form · 1–1",
        summary: "12 prior matches · 75% win rate going in",
        rows: [
          {
            matchId: "m-prev-1",
            won: true,
            opponentLabel: "silva.r",
            dateLabel: "May 9",
            scoreLabel: "3–1",
          },
          {
            matchId: "m-prev-2",
            won: false,
            opponentLabel: "tanaka.y",
            dateLabel: "May 7",
            scoreLabel: "1–3",
          },
        ],
      },
      career: { matches: 12, winRateLabel: "75%", highWinRate: true },
    });
  });

  it("uses the singular 'match' in the summary after exactly one career match", async () => {
    playersPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          recent_form: [
            buildMatchDetailsPlayerForm({
              career_matches_before: 1,
              career_wins_before: 0,
            }),
          ],
        }),
      ),
    );

    const result = await renderPanel();

    const form = result.current.data?.left?.form;
    expect(form?.kind).toBe("history");
    if (form?.kind === "history") {
      expect(form.summary).toBe("1 prior match · 0% win rate going in");
    }
  });

  it("labels a form row's missing opponent as No opponent", async () => {
    playersPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          recent_form: [
            buildMatchDetailsPlayerForm({
              recent_results: [
                buildMatchDetailsFormResult({ opponent_username: null }),
              ],
            }),
          ],
        }),
      ),
    );

    const result = await renderPanel();

    const form = result.current.data?.left?.form;
    if (form?.kind === "history") {
      expect(form.rows[0].opponentLabel).toBe("No opponent");
    }
    expect(form?.kind).toBe("history");
  });

  it("addresses the empty-form sentence to the viewer on their own side", async () => {
    playersPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ recent_form: [] })),
    );

    const result = await renderPanel();

    expect(result.current.data?.left?.form).toEqual({
      kind: "empty",
      emptyText: "No prior matches yet — this is your first one.",
    });
    expect(result.current.data?.right?.form).toEqual({
      kind: "empty",
      emptyText: "No prior matches yet — this is their first one.",
    });
  });

  it("marks a player with no form entry as Unrated with no sparkline and no win rate", async () => {
    playersPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ recent_form: [] })),
    );

    const result = await renderPanel();

    expect(result.current.data?.left?.rating).toEqual({
      value: null,
      sparkline: null,
    });
    expect(result.current.data?.left?.career).toEqual({
      matches: 0,
      winRateLabel: null,
      highWinRate: false,
    });
  });

  it("withholds the sparkline when the rating history has fewer than two points", async () => {
    playersPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          recent_form: [
            buildMatchDetailsPlayerForm({ rating_history: [1612] }),
          ],
        }),
      ),
    );

    const result = await renderPanel();

    expect(result.current.data?.left?.rating).toEqual({
      value: 1612,
      sparkline: null,
    });
  });

  it("does not highlight a sub-50% career win rate", async () => {
    playersPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          recent_form: [
            buildMatchDetailsPlayerForm({
              career_matches_before: 10,
              career_wins_before: 4,
            }),
          ],
        }),
      ),
    );

    const result = await renderPanel();

    expect(result.current.data?.left?.career).toEqual({
      matches: 10,
      winRateLabel: "40%",
      highWinRate: false,
    });
  });

  it("marks a winning side's profile as won", async () => {
    playersPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide({ won: true }),
            buildMatchDetailsSide({
              side_number: 2,
              won: false,
              is_current_user_side: false,
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-opponent",
                  username: "leo.mertens",
                  is_current_user: false,
                }),
              ],
            }),
          ],
        }),
      ),
    );

    const result = await renderPanel();

    expect(result.current.data?.left?.won).toBe(true);
    expect(result.current.data?.right?.won).toBe(false);
  });

  it("orders the viewer's side left even when they're side 2", async () => {
    playersPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide({
              side_number: 1,
              is_current_user_side: false,
              players: [
                buildMatchDetailsPlayer({
                  user_id: "u-opponent",
                  username: "leo.mertens",
                  is_current_user: false,
                }),
              ],
            }),
            buildMatchDetailsSide({
              side_number: 2,
              is_current_user_side: true,
              players: [buildMatchDetailsPlayer()],
            }),
          ],
        }),
      ),
    );

    const result = await renderPanel();

    expect(result.current.data?.left?.name).toBe("rita.kovac");
    expect(result.current.data?.right?.name).toBe("leo.mertens");
  });

  it("projects a missing second side as a null right profile", async () => {
    playersPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ sides: [buildMatchDetailsSide()] }),
      ),
    );

    const result = await renderPanel();

    expect(result.current.data?.left?.name).toBe("rita.kovac");
    expect(result.current.data?.right).toBeNull();
  });

  it("projects a playerless ghost side as a null profile", async () => {
    playersPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          sides: [
            buildMatchDetailsSide(),
            buildMatchDetailsSide({
              side_number: 2,
              is_current_user_side: false,
              players: [],
            }),
          ],
        }),
      ),
    );

    const result = await renderPanel();

    expect(result.current.data?.right).toBeNull();
  });
});
