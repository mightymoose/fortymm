import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsPlayer,
  buildMatchDetailsPlayerForm,
  buildMatchDetailsSide,
  type MatchDetails,
} from "@/mocks/factories/matches/match-details.factory";
import {
  buildMatchDetailsData,
  buildScoreboard,
} from "@/mocks/factories/matches/scoreboard.factory";
import { waitFor } from "@/test/utilities";

import { ratingsQuery } from "./ratings-query";
import { ratingsQueryPage } from "./ratings-query.page";

/** A completed, rated match the viewer won 3–1: +12 for rita.kovac (with a
 * rating history), −12 for leo.mertens (no history beyond his before). */
const finalRatedMatch = (overrides: Partial<MatchDetails> = {}): MatchDetails =>
  buildMatchDetails({
    status: "completed",
    status_label: "Final",
    sides: [
      buildMatchDetailsSide({
        games_won: 3,
        won: true,
        rating_change: { before: 1612, after: 1624.4, delta: 12.4 },
      }),
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
        rating_change: { before: 1540, after: 1527.6, delta: -12.4 },
      }),
    ],
    recent_form: [
      buildMatchDetailsPlayerForm({
        user_id: "u-me",
        rating_history: [1580, 1601, 1612],
      }),
      buildMatchDetailsPlayerForm({
        user_id: "u-opponent",
        rating_before: 1540,
        rating_history: [],
      }),
    ],
    data: buildMatchDetailsData({
      scoreboard: buildScoreboard({ status: "final" }),
    }),
    ...overrides,
  });

const renderRatings = async (matchId?: string) => {
  const { result } = ratingsQueryPage.render(matchId);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result;
};

describe("ratingsQuery", () => {
  it("shares the match-details query key so the page's BFF fetch is reused", () => {
    expect(ratingsQuery("m-1").queryKey).toEqual([
      { scope: "matches", version: "v1", entity: "details", matchId: "m-1" },
    ]);
  });

  it("projects perspective-ordered rows with rounded numbers and a signed delta", async () => {
    ratingsQueryPage.mockEndpoint(() => HttpResponse.json(finalRatedMatch()));

    const result = await renderRatings();

    expect(result.current.data).toEqual({
      rows: [
        {
          username: "rita.kovac",
          initials: "RK",
          won: true,
          change: {
            from: 1612,
            to: 1624,
            deltaLabel: "+12",
            deltaUp: true,
            // History anchored before the match, post-match value appended.
            sparkline: [1580, 1601, 1612, 1624.4],
          },
        },
        {
          username: "leo.mertens",
          initials: "LM",
          won: false,
          change: {
            from: 1540,
            to: 1528,
            deltaLabel: "-12",
            deltaUp: false,
            // No history — the line is anchored at the pre-match rating.
            sparkline: [1540, 1527.6],
          },
        },
      ],
    });
  });

  it("is null until the match is final, even when seeded rating changes exist", async () => {
    // A live match may carry projected ratings; a "result" card mid-match
    // would contradict the pre-match snapshot panel.
    ratingsQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        finalRatedMatch({
          status: "in_progress",
          status_label: "Live",
          data: buildMatchDetailsData({
            scoreboard: buildScoreboard({ status: "live" }),
          }),
        }),
      ),
    );

    const result = await renderRatings();

    expect(result.current.data).toBeNull();
  });

  it("is null when a final match moved no ratings", async () => {
    const match = finalRatedMatch();
    ratingsQueryPage.mockEndpoint(() =>
      HttpResponse.json({
        ...match,
        sides: match.sides.map((s) => ({ ...s, rating_change: null })),
      }),
    );

    const result = await renderRatings();

    expect(result.current.data).toBeNull();
  });

  it("shows the card when only one side's rating moved, the other reading as unrated", async () => {
    const match = finalRatedMatch();
    ratingsQueryPage.mockEndpoint(() =>
      HttpResponse.json({
        ...match,
        sides: match.sides.map((s) =>
          s.side_number === 2 ? { ...s, rating_change: null } : s,
        ),
      }),
    );

    const result = await renderRatings();

    expect(result.current.data?.rows[0].change).not.toBeNull();
    expect(result.current.data?.rows[1]).toMatchObject({
      username: "leo.mertens",
      change: null,
    });
  });

  it("withholds the sparkline for a first-rating player with no history", async () => {
    // before: null and no history leaves only the post-match point — not
    // enough to draw a line.
    const match = finalRatedMatch();
    ratingsQueryPage.mockEndpoint(() =>
      HttpResponse.json({
        ...match,
        sides: match.sides.map((s) =>
          s.side_number === 2
            ? {
                ...s,
                rating_change: { before: null, after: 1500, delta: 0 },
              }
            : s,
        ),
      }),
    );

    const result = await renderRatings();

    expect(result.current.data?.rows[1].change).toEqual({
      from: null,
      to: 1500,
      deltaLabel: "0",
      deltaUp: true,
      sparkline: null,
    });
  });

  it("orders side 1 first when the viewer is not a participant", async () => {
    const match = finalRatedMatch();
    ratingsQueryPage.mockEndpoint(() =>
      HttpResponse.json({
        ...match,
        sides: [...match.sides]
          .reverse()
          .map((s) => ({ ...s, is_current_user_side: false })),
      }),
    );

    const result = await renderRatings();

    expect(result.current.data?.rows.map((r) => r.username)).toEqual([
      "rita.kovac",
      "leo.mertens",
    ]);
  });

  it("labels a playerless side with its non-participant stand-in", async () => {
    const match = finalRatedMatch();
    ratingsQueryPage.mockEndpoint(() =>
      HttpResponse.json({
        ...match,
        sides: match.sides.map((s) =>
          s.side_number === 2
            ? { ...s, players: [], rating_change: null }
            : { ...s, is_current_user_side: false },
        ),
      }),
    );

    const result = await renderRatings();

    expect(result.current.data?.rows[1]).toMatchObject({
      username: "Side 2",
      initials: "S2",
    });
  });

  it("labels playerless sides Side 1 / Side 2 for a non-participant viewer", async () => {
    const match = finalRatedMatch();
    ratingsQueryPage.mockEndpoint(() =>
      HttpResponse.json({
        ...match,
        sides: match.sides.map((s, i) => ({
          ...s,
          players: [],
          is_current_user_side: false,
          // Keep one change so the card still shows.
          rating_change: i === 0 ? s.rating_change : null,
        })),
      }),
    );

    const result = await renderRatings();

    expect(result.current.data?.rows.map((r) => r.username)).toEqual([
      "Side 1",
      "Side 2",
    ]);
  });

  it("labels the viewer's own playerless side You", async () => {
    const match = finalRatedMatch();
    ratingsQueryPage.mockEndpoint(() =>
      HttpResponse.json({
        ...match,
        sides: match.sides.map((s) =>
          s.side_number === 1 ? { ...s, players: [] } : s,
        ),
      }),
    );

    const result = await renderRatings();

    expect(result.current.data?.rows[0]).toMatchObject({ username: "You" });
  });

  it("labels a playerless side Opponent when the viewer participates", async () => {
    const match = finalRatedMatch();
    ratingsQueryPage.mockEndpoint(() =>
      HttpResponse.json({
        ...match,
        sides: match.sides.map((s) =>
          s.side_number === 2 ? { ...s, players: [], rating_change: null } : s,
        ),
      }),
    );

    const result = await renderRatings();

    expect(result.current.data?.rows[1]).toMatchObject({
      username: "Opponent",
    });
  });
});
