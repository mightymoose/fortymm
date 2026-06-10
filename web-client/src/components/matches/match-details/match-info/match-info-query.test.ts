import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { matchInfoQuery } from "./match-info-query";
import { matchInfoQueryPage } from "./match-info-query.page";

const renderInfo = async (matchId?: string) => {
  const { result } = matchInfoQueryPage.render(matchId);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result;
};

describe("matchInfoQuery", () => {
  it("shares the match-details query key so the page's BFF fetch is reused", () => {
    expect(matchInfoQuery("m-1").queryKey).toEqual([
      { scope: "matches", version: "v1", entity: "details", matchId: "m-1" },
    ]);
  });

  it("projects the format, status, and rated rows in card order", async () => {
    matchInfoQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          team_size: 1,
          best_of: 5,
          games_to_win: 3,
          status_label: "Scheduled",
          affects_rating: true,
        }),
      ),
    );

    const result = await renderInfo();

    expect(result.current.data?.rows).toEqual([
      { label: "Format", value: "Singles · Best of 5, first to 3" },
      { label: "Status", value: "Scheduled" },
      { label: "Rated", value: "Yes" },
    ]);
  });

  it("labels a two-player team size as Doubles with its own race line", async () => {
    matchInfoQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ team_size: 2, best_of: 3, games_to_win: 2 }),
      ),
    );

    const result = await renderInfo();

    expect(result.current.data?.rows[0]).toEqual({
      label: "Format",
      value: "Doubles · Best of 3, first to 2",
    });
  });

  it("passes the server's status label through untouched", async () => {
    matchInfoQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ status_label: "In progress" })),
    );

    const result = await renderInfo();

    expect(result.current.data?.rows[1]).toEqual({
      label: "Status",
      value: "In progress",
    });
  });

  it("reads an unrated match as Rated · No", async () => {
    matchInfoQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ affects_rating: false })),
    );

    const result = await renderInfo();

    expect(result.current.data?.rows[2]).toEqual({
      label: "Rated",
      value: "No",
    });
  });
});
