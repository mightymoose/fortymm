import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { callStatusQuery } from "./call-status-banner-query";
import { callStatusQueryPage } from "./call-status-banner-query.page";

const liveTournament = {
  tournament_id: "t-1",
  tournament_name: "Summer Smash",
  tournament_status: "live" as const,
  event_id: "e-1",
  event_name: "Open Singles",
  table_label: null,
  can_edit: false,
};

describe("callStatusQuery", () => {
  it("shares the match-details query key so the page's BFF fetch is reused", () => {
    expect(callStatusQuery("m-1").queryKey).toEqual([
      { scope: "matches", version: "v1", entity: "details", matchId: "m-1" },
    ]);
  });

  it("projects 'none' when the match is scorable", async () => {
    callStatusQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ not_scorable_reason: null })),
    );

    const { result } = callStatusQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ kind: "none" });
  });

  it("projects 'none' for a casual match with no tournament — regression for the pre-#1288 render (AC #6)", async () => {
    callStatusQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ not_scorable_reason: null, tournament: undefined }),
      ),
    );

    const { result } = callStatusQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ kind: "none" });
  });

  it("projects 'awaiting_placement' when the tournament hasn't gone live, naming the placed table when set", async () => {
    callStatusQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          not_scorable_reason: "not_called",
          tournament: {
            ...liveTournament,
            tournament_status: "published",
            table_label: "Table 3",
          },
        }),
      ),
    );

    const { result } = callStatusQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      kind: "awaiting_placement",
      tournamentName: "Summer Smash",
      eventName: "Open Singles",
      tableLabel: "Table 3",
    });
  });

  it("projects 'awaiting_placement' with a null table label when nothing's been placed", async () => {
    callStatusQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          not_scorable_reason: "not_called",
          tournament: { ...liveTournament, tournament_status: "draft" },
        }),
      ),
    );

    const { result } = callStatusQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      kind: "awaiting_placement",
      tournamentName: "Summer Smash",
      eventName: "Open Singles",
      tableLabel: null,
    });
  });

  it("projects 'awaiting_call' with canEdit for the tournament owner once the tournament is live", async () => {
    callStatusQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          not_scorable_reason: "not_called",
          tournament: { ...liveTournament, can_edit: true },
        }),
      ),
    );

    const { result } = callStatusQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      kind: "awaiting_call",
      tournamentId: "t-1",
      tournamentName: "Summer Smash",
      eventName: "Open Singles",
      canEdit: true,
    });
  });

  it("projects 'awaiting_call' with canEdit false for a non-owner once the tournament is live", async () => {
    callStatusQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          not_scorable_reason: "not_called",
          tournament: { ...liveTournament, can_edit: false },
        }),
      ),
    );

    const { result } = callStatusQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      kind: "awaiting_call",
      tournamentId: "t-1",
      tournamentName: "Summer Smash",
      eventName: "Open Singles",
      canEdit: false,
    });
  });

  it("projects 'awaiting_call_hidden' when not_called but the tournament isn't visible to the viewer", async () => {
    callStatusQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          not_scorable_reason: "not_called",
          tournament: undefined,
        }),
      ),
    );

    const { result } = callStatusQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ kind: "awaiting_call_hidden" });
  });

  it("projects 'not_scorable' (not 'awaiting_placement') for an uncalled fixture whose tournament already archived — never says 'hasn't gone live yet' about one that's over", async () => {
    callStatusQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          not_scorable_reason: "not_called",
          tournament: { ...liveTournament, tournament_status: "archived" },
        }),
      ),
    );

    const { result } = callStatusQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      kind: "not_scorable",
      reason: "not_scorable",
    });
  });

  it("projects 'result_posted' distinctly from the not-called cases", async () => {
    callStatusQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          not_scorable_reason: "result_posted",
          tournament: liveTournament,
        }),
      ),
    );

    const { result } = callStatusQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ kind: "result_posted" });
  });

  it("projects 'not_scorable' with the reason for no_opponent", async () => {
    callStatusQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ not_scorable_reason: "no_opponent" }),
      ),
    );

    const { result } = callStatusQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      kind: "not_scorable",
      reason: "no_opponent",
    });
  });

  it("projects 'not_scorable' with the reason for a terminal match", async () => {
    callStatusQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ not_scorable_reason: "not_scorable" }),
      ),
    );

    const { result } = callStatusQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      kind: "not_scorable",
      reason: "not_scorable",
    });
  });
});
