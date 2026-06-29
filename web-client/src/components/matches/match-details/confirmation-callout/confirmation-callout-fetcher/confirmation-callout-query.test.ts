import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  type MatchDetails,
} from "@/mocks/factories/matches/match-details.factory";
import type { components } from "@/api/schema";
import { waitFor } from "@/test/utilities";

import { confirmationCalloutQuery } from "./confirmation-callout-query";
import { confirmationCalloutQueryPage } from "./confirmation-callout-query.page";

type MatchNegotiation = components["schemas"]["MatchNegotiation"];
type NegotiationResult = components["schemas"]["NegotiationResult"];

const standingResult = (id = "r-1"): NegotiationResult => ({
  id,
  games: [{ game_number: 1, side_1_points: 11, side_2_points: 7 }],
  submitted_by: "u-opponent",
  submitted_at: "2026-06-10T12:00:00Z",
});

/** A live match with a standing proposal the opponent posted — the viewer must
 * act (negotiation `review`). */
const reviewMatch = (negotiation: Partial<MatchNegotiation> = {}): MatchDetails =>
  buildMatchDetails({
    status: "in_progress",
    status_label: "Awaiting confirmation",
    negotiation: {
      viewer_state: "review",
      your_turn: true,
      standing_result: standingResult(),
      prior_result: null,
      diff: null,
      ...negotiation,
    },
  });

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

  it("projects the actionable state with the standing result id when it's the viewer's turn", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(reviewMatch()),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({ kind: "actionable", resultId: "r-1" });
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

  it("projects null once the match is final", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        reviewMatch({
          viewer_state: "final",
          your_turn: false,
          standing_result: standingResult(),
        }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });

  it("projects null when there is no standing result (live)", async () => {
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
