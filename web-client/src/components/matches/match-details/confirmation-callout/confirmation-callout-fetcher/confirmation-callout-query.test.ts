import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsPlayer,
  buildMatchDetailsSide,
  type MatchDetails,
} from "@/mocks/factories/matches/match-details.factory";
import type { components } from "@/api/schema";
import { waitFor } from "@/test/utilities";

import { confirmationCalloutQuery } from "./confirmation-callout-query";
import { confirmationCalloutQueryPage } from "./confirmation-callout-query.page";

type MatchNegotiation = components["schemas"]["MatchNegotiation"];
type NegotiationResult = components["schemas"]["NegotiationResult"];
type NegotiationDiffEntry = components["schemas"]["NegotiationDiffEntry"];

const standingResult = (id = "r-1"): NegotiationResult => ({
  id,
  games: [{ game_number: 1, side_1_points: 11, side_2_points: 7 }],
  submitted_by: "u-opponent",
  submitted_at: "2026-06-10T12:00:00Z",
});

const diffEntry: NegotiationDiffEntry = {
  game_number: 1,
  old: { game_number: 1, side_1_points: 11, side_2_points: 7 },
  new: { game_number: 1, side_1_points: 11, side_2_points: 9 },
};

/** A live match with a standing proposal the opponent posted — the viewer must
 * act (negotiation `review`). */
const reviewMatch = (
  negotiation: Partial<MatchNegotiation> = {},
  overrides: Partial<MatchDetails> = {},
): MatchDetails =>
  buildMatchDetails({
    status: "in_progress",
    status_label: "Awaiting acceptance",
    negotiation: {
      viewer_state: "review",
      your_turn: true,
      standing_result: standingResult(),
      prior_result: null,
      diff: null,
      ...negotiation,
    },
    ...overrides,
  });

/** Both sides belonging to somebody else — the shape the BFF serves a viewer
 * who isn't playing in this match (the tournament's director, or a
 * spectator). */
const sidesWithNoViewerSide = (): MatchDetails["sides"] => [
  buildMatchDetailsSide({
    side_number: 1,
    players: [
      buildMatchDetailsPlayer({
        user_id: "u-player-1",
        username: "ana.silva",
        is_current_user: false,
      }),
    ],
    is_current_user_side: false,
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
    is_current_user_side: false,
  }),
];

const renderView = async () => {
  const { result } = confirmationCalloutQueryPage.render();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result;
};

describe("confirmationCalloutQuery", () => {
  it("shares the match-details query key so the page's BFF fetch is reused", () => {
    expect(confirmationCalloutQuery("m-1").queryKey).toEqual([
      { scope: "matches", version: "v1", entity: "details", matchId: "m-1" },
    ]);
  });

  it("projects the review state with the standing result id + rated stakes", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(reviewMatch()),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({
      kind: "review",
      resultId: "r-1",
      rated: true,
      retirementDeadline: null,
      officiating: false,
    });
  });

  it("carries the unrated stakes through from affects_rating", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(reviewMatch({}, { affects_rating: false })),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({
      kind: "review",
      resultId: "r-1",
      rated: false,
      retirementDeadline: null,
      officiating: false,
    });
  });

  it("projects the corrected state with the standing id and the server diff", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        reviewMatch({
          viewer_state: "corrected",
          standing_result: standingResult("r-2"),
          prior_result: standingResult("r-0"),
          diff: [diffEntry],
        }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({
      kind: "corrected",
      resultId: "r-2",
      rated: true,
      diff: [diffEntry],
      retirementDeadline: null,
    });
  });

  it("defaults a corrected state's diff to an empty array when the server sends null", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        reviewMatch({
          viewer_state: "corrected",
          standing_result: standingResult("r-2"),
          prior_result: standingResult("r-0"),
          diff: null,
        }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toMatchObject({ kind: "corrected", diff: [] });
  });

  it("carries the retirement deadline through to the review view when set", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        reviewMatch({ retirement_deadline: "2026-06-12T12:00:00Z" }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toMatchObject({
      kind: "review",
      retirementDeadline: "2026-06-12T12:00:00Z",
    });
  });

  it("soft-fails a malformed retirement deadline to null rather than throwing", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        reviewMatch({ retirement_deadline: "not-a-date" as unknown as string }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toMatchObject({
      kind: "review",
      retirementDeadline: null,
    });
  });

  it("projects the awaiting state, naming the opponent, when the viewer's own side proposed", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        reviewMatch({
          viewer_state: "awaiting",
          your_turn: false,
          standing_result: { ...standingResult(), submitted_by: "u-me" },
        }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({
      kind: "awaiting",
      pendingSignerName: "leo.mertens",
    });
  });

  it("flags the review view as officiating when your_turn lands on a viewer who is on neither side", async () => {
    // The tournament director reading a match they don't play in (#1523): the
    // BFF says it's their turn, yet no side is theirs. That pairing is
    // unreachable for a player, so it's what the copy branch keys off.
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(reviewMatch({}, { sides: sidesWithNoViewerSide() })),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({
      kind: "review",
      resultId: "r-1",
      rated: true,
      retirementDeadline: null,
      officiating: true,
    });
  });

  it("projects null for a spectator in the review state (your_turn=false), hiding the Accept callout", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        reviewMatch({
          viewer_state: "review",
          your_turn: false,
          standing_result: standingResult(),
        }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });

  it("projects null for a spectator in the corrected state (your_turn=false), hiding the Accept callout", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        reviewMatch({
          viewer_state: "corrected",
          your_turn: false,
          standing_result: standingResult("r-2"),
          prior_result: standingResult("r-0"),
          diff: [diffEntry],
        }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });

  it("projects null once the match is settled (final) — the callout is gone", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        reviewMatch({
          viewer_state: "final",
          your_turn: false,
          standing_result: null,
        }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });

  it("projects null when there is no proposal in play (live)", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        reviewMatch({
          viewer_state: "live",
          your_turn: false,
          standing_result: null,
        }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });
});
