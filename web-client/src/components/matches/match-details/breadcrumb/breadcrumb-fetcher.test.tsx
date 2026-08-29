import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { breadcrumbFetcherPage } from "./breadcrumb-fetcher.page";

describe("BreadcrumbFetcher", () => {
  it("resolves the query and hands the tournament crumb to the display", async () => {
    breadcrumbFetcherPage.mockEndpoint(() =>
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

    breadcrumbFetcherPage.render();

    // Wiring only: the link's target and full crumb order are pinned by the
    // query and display tests.
    expect(
      await breadcrumbFetcherPage.findTournamentLink("Summer Smash"),
    ).toBeInTheDocument();
  });

  it("renders the plain casual-match crumb when the query resolves to no tournament", async () => {
    breadcrumbFetcherPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ tournament: undefined, not_scorable_reason: null }),
      ),
    );

    breadcrumbFetcherPage.render();

    await breadcrumbFetcherPage.findCurrent(/^Match /);
    expect(
      breadcrumbFetcherPage.queryTournamentLink("Summer Smash"),
    ).not.toBeInTheDocument();
  });

  it("propagates a query failure to the nearest error boundary", async () => {
    breadcrumbFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    breadcrumbFetcherPage.render();

    await waitFor(() =>
      expect(breadcrumbFetcherPage.queryError()).toBeInTheDocument(),
    );
  });
});
