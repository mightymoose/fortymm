import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  type MatchDetails,
  type MatchSignatureView,
} from "@/mocks/factories/matches/match-details.factory";
import {
  buildMatchDetailsData,
  buildScoreboard,
} from "@/mocks/factories/matches/scoreboard.factory";
import { waitFor } from "@/test/utilities";

import { confirmationCalloutQuery } from "./confirmation-callout-query";
import { confirmationCalloutQueryPage } from "./confirmation-callout-query.page";

const viewerSignature: MatchSignatureView = {
  user_id: "u-me",
  signed_at: "2026-06-10T12:00:00Z",
};
const opponentSignature: MatchSignatureView = {
  user_id: "u-opponent",
  signed_at: "2026-06-10T12:05:00Z",
};

/** A live match where the viewer (rita.kovac, `u-me`) has posted + signed the
 * result and leo.mertens (`u-opponent`) hasn't signed yet — the canonical
 * "awaiting confirmation" state. */
const awaitingMatch = (overrides: Partial<MatchDetails> = {}): MatchDetails =>
  buildMatchDetails({
    status: "in_progress",
    status_label: "Awaiting confirmation",
    can_confirm: false,
    // The viewer posted this result, so they may retract it.
    can_withdraw: true,
    signatures: [viewerSignature],
    data: buildMatchDetailsData({
      scoreboard: buildScoreboard({ status: "live" }),
    }),
    ...overrides,
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

  it("projects the actionable state whenever the backend says the viewer can confirm", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        awaitingMatch({ can_confirm: true, signatures: [opponentSignature] }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({ kind: "actionable" });
  });

  it("projects the awaiting state, naming the unsigned opponent, once the viewer has signed", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(awaitingMatch()),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({
      kind: "awaiting",
      pendingSignerName: "leo.mertens",
      canWithdraw: true,
    });
  });

  it("falls back to 'your opponent' when no unsigned opposing player can be resolved", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        awaitingMatch({ signatures: [viewerSignature, opponentSignature] }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({
      kind: "awaiting",
      pendingSignerName: "your opponent",
      canWithdraw: true,
    });
  });

  it("passes the backend's can_withdraw through to the awaiting view", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(awaitingMatch({ can_withdraw: false })),
    );

    const result = await renderView();

    expect(result.current.data).toEqual({
      kind: "awaiting",
      pendingSignerName: "leo.mertens",
      canWithdraw: false,
    });
  });

  it("projects null once the match is final, despite the lingering signatures (#358)", async () => {
    // The opponent has now confirmed: the scoreboard flips to `final` and both
    // signatures stay on record. The signer's passive notice must disappear
    // rather than linger above a Final match — even across a reload.
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        awaitingMatch({
          status: "completed",
          status_label: "Final",
          signatures: [viewerSignature, opponentSignature],
          data: buildMatchDetailsData({
            scoreboard: buildScoreboard({ status: "final" }),
          }),
        }),
      ),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });

  it("projects null when there are no signatures to wait on", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(awaitingMatch({ signatures: [] })),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });

  it("projects null when the viewer hasn't signed (the posted result isn't theirs to wait on)", async () => {
    confirmationCalloutQueryPage.mockEndpoint(() =>
      HttpResponse.json(awaitingMatch({ signatures: [opponentSignature] })),
    );

    const result = await renderView();

    expect(result.current.data).toBeNull();
  });

  it("projects null for a spectator, whatever the signature state", async () => {
    const match = awaitingMatch();
    confirmationCalloutQueryPage.mockEndpoint(() =>
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
