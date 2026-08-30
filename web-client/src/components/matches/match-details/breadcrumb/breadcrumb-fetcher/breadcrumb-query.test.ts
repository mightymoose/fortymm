import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { breadcrumbQuery } from "./breadcrumb-query";
import { breadcrumbQueryPage } from "./breadcrumb-query.page";

describe("breadcrumbQuery", () => {
  it("shares the match-details query key so the page's BFF fetch is reused", () => {
    expect(breadcrumbQuery("m-1").queryKey).toEqual([
      { scope: "matches", version: "v1", entity: "details", matchId: "m-1" },
    ]);
  });

  it("projects null for a casual match — the breadcrumb stays unchanged (AC #8)", async () => {
    breadcrumbQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ tournament: undefined, not_scorable_reason: null }),
      ),
    );

    const { result } = breadcrumbQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("projects the tournament id and name when the match belongs to a tournament fixture", async () => {
    breadcrumbQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          tournament: {
            tournament_id: "t-1",
            tournament_name: "Summer Smash",
            tournament_status: "live",
            event_id: "e-1",
            event_name: "Open Singles",
            table_label: "Table 3",
            can_edit: true,
          },
        }),
      ),
    );

    const { result } = breadcrumbQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      tournamentId: "t-1",
      tournamentName: "Summer Smash",
    });
  });

  it("still projects the tournament for an already-scorable (called) fixture — unconditional on not_scorable_reason (AC #2)", async () => {
    breadcrumbQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          not_scorable_reason: null,
          tournament: {
            tournament_id: "t-2",
            tournament_name: "Winter Cup",
            tournament_status: "live",
            event_id: "e-2",
            event_name: "Mixed Doubles",
            table_label: "Table 1",
            can_edit: false,
          },
        }),
      ),
    );

    const { result } = breadcrumbQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      tournamentId: "t-2",
      tournamentName: "Winter Cup",
    });
  });
});
