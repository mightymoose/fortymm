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
import {
  buildEstablishedRatingChange,
  buildRatingChange,
} from "@/mocks/factories/players/rating-change.factory";
import { waitFor } from "@/test/utilities";

import { ratingsQuery } from "./ratings-query";
import { ratingsQueryPage } from "./ratings-query.page";

/** A completed, rated match the viewer won 3–1: +12 for rita.kovac (with a
 * rating history), −12 for leo.mertens (no history beyond his before). Both
 * players were **already rated** — their ratings MOVED. */
const finalRatedMatch = (overrides: Partial<MatchDetails> = {}): MatchDetails =>
  buildMatchDetails({
    status: "completed",
    status_label: "Final",
    sides: [
      buildMatchDetailsSide({
        games_won: 3,
        won: true,
        rating_change: buildRatingChange({ before: 1612, after: 1624.4 }),
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
        rating_change: buildRatingChange({ before: 1540, after: 1527.6 }),
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

/**
 * The same match, but it is **leo.mertens's first rated match**: he went in
 * Unrated and came out at 1268. His side carries a *present* rating change whose
 * `delta` is null — the second of the two nulls, and the one the profile, the
 * roster and the pre-match snapshot already refuse to narrate as a 1500 (#952).
 *
 * The viewer (already rated) still moves, so a single payload holds both kinds
 * and a projection that collapsed them would be caught by either row.
 */
const establishedForOpponent = (): MatchDetails => {
  const match = finalRatedMatch();
  return {
    ...match,
    sides: match.sides.map((s) =>
      s.side_number === 2
        ? { ...s, rating_change: buildEstablishedRatingChange({ after: 1268 }) }
        : s,
    ),
    // He has no rating history: a timeline is a sequence of rated matches and
    // this is his first.
    recent_form: match.recent_form?.map((f) =>
      f.user_id === "u-opponent"
        ? { ...f, rating_before: null, rating_history: [] }
        : f,
    ),
  };
};

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
            kind: "moved",
            from: 1612,
            to: 1624,
            deltaLabel: "+12",
            deltaAriaLabel: "Gained 12 rating",
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
            kind: "moved",
            from: 1540,
            to: 1528,
            deltaLabel: "-12",
            deltaAriaLabel: "Lost 12 rating",
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

  it("projects a first rated match as ESTABLISHED — no delta, no trend line", async () => {
    // The second of the two nulls: the change is PRESENT, but its `delta` is
    // null because there was no prior rating to move from. The player was
    // Unrated going in and came out at 1268 — they did not *lose* 232 points of
    // the 1500 their league-join seeded (#952).
    const match = establishedForOpponent();
    ratingsQueryPage.mockEndpoint(() => HttpResponse.json(match));

    const result = await renderRatings();

    expect(result.current.data?.rows[1].change).toEqual({
      kind: "established",
      to: 1268,
      ariaLabel: "Unrated before this match, now rated 1268",
    });
  });

  it("never reports a delta, a direction or a from-number for an established rating", async () => {
    // The projection is the last place that could resurrect the phantom, so
    // pin its *absence*: no delta label to print, no up/down tone to pick, no
    // 1500 to have fallen from. A `null >= 0` would have made all three.
    ratingsQueryPage.mockEndpoint(() =>
      HttpResponse.json(establishedForOpponent()),
    );

    const result = await renderRatings();

    const change = result.current.data?.rows[1].change;
    expect(change).not.toBeNull();
    expect(JSON.stringify(change)).not.toContain("1500");
    expect(change).not.toHaveProperty("deltaLabel");
    expect(change).not.toHaveProperty("deltaAriaLabel");
    expect(change).not.toHaveProperty("deltaUp");
    expect(change).not.toHaveProperty("from");
    expect(change).not.toHaveProperty("sparkline");
  });

  it("keeps the two nulls apart: no change at all is not an established rating", async () => {
    // `rating_change: null` (this match moved no rating) and a change with a
    // null `delta` (this match *gave* the player their rating) are different
    // facts and must not collapse into one branch.
    const noChange = finalRatedMatch();
    ratingsQueryPage.mockEndpoint(() =>
      HttpResponse.json({
        ...noChange,
        sides: noChange.sides.map((s) =>
          s.side_number === 2 ? { ...s, rating_change: null } : s,
        ),
      }),
    );

    const result = await renderRatings();

    expect(result.current.data?.rows[1].change).toBeNull();
  });

  it("still moves an already-rated player, unchanged", async () => {
    // The regression guard for the fix itself: an ordinary rated match keeps its
    // signed delta and its trend line.
    ratingsQueryPage.mockEndpoint(() =>
      HttpResponse.json(establishedForOpponent()),
    );

    const result = await renderRatings();

    expect(result.current.data?.rows[0].change).toMatchObject({
      kind: "moved",
      from: 1612,
      to: 1624,
      deltaLabel: "+12",
      deltaUp: true,
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
