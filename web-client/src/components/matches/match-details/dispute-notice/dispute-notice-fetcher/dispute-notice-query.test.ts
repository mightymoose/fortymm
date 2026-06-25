import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  type MatchDetails,
} from "@/mocks/factories/matches/match-details.factory";
import {
  buildMatchDetailsData,
  buildScoreboard,
} from "@/mocks/factories/matches/scoreboard.factory";
import { waitFor } from "@/test/utilities";

import { disputeNoticeQuery } from "./dispute-notice-query";
import { disputeNoticeQueryPage } from "./dispute-notice-query.page";

/** A disputed match: the viewer (rita.kovac, `u-me`) posted the result and
 * leo.mertens (`u-opponent`) disputed it. Signatures are cleared and the board
 * is back to scorable — the canonical disputed shape from the submitter's
 * perspective. */
const disputedMatch = (overrides: Partial<MatchDetails> = {}): MatchDetails =>
  buildMatchDetails({
    status: "disputed",
    status_label: "Disputed",
    can_confirm: false,
    can_score: true,
    signatures: [],
    disputed_by_user_id: "u-opponent",
    data: buildMatchDetailsData({
      scoreboard: buildScoreboard({ status: "final" }),
    }),
    ...overrides,
  });

const renderView = async () => {
  const { result } = disputeNoticeQueryPage.render();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result;
};

describe("disputeNoticeQuery", () => {
  it("shares the match-details query key so the page's BFF fetch is reused", () => {
    expect(disputeNoticeQuery("m-1").queryKey).toEqual([
      { scope: "matches", version: "v1", entity: "details", matchId: "m-1" },
    ]);
  });

  it("names the opponent who disputed when the viewer is the submitter", async () => {
    disputeNoticeQueryPage.mockEndpoint(() =>
      HttpResponse.json(disputedMatch()),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({ disputerName: "leo.mertens" });
  });

  it("falls back to 'Your opponent' when the disputer id matches no listed player", async () => {
    disputeNoticeQueryPage.mockEndpoint(() =>
      HttpResponse.json(disputedMatch({ disputed_by_user_id: "u-ghost" })),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({ disputerName: "Your opponent" });
  });

  it("projects null when the match isn't disputed", async () => {
    disputeNoticeQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        disputedMatch({
          status: "in_progress",
          status_label: "Live",
          disputed_by_user_id: null,
        }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });

  it("projects null when no disputer is recorded", async () => {
    disputeNoticeQueryPage.mockEndpoint(() =>
      HttpResponse.json(disputedMatch({ disputed_by_user_id: null })),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });

  it("projects null for the disputer themselves (their acknowledgement is a separate flow)", async () => {
    // The viewer (`u-me`) is the one who disputed — they don't get "your
    // result was disputed".
    disputeNoticeQueryPage.mockEndpoint(() =>
      HttpResponse.json(disputedMatch({ disputed_by_user_id: "u-me" })),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });

  it("projects null for a spectator", async () => {
    const match = disputedMatch();
    disputeNoticeQueryPage.mockEndpoint(() =>
      HttpResponse.json({
        ...match,
        sides: match.sides.map((side) => ({
          ...side,
          is_current_user_side: false,
          players: side.players.map((p) => ({ ...p, is_current_user: false })),
        })),
      }),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });
});
