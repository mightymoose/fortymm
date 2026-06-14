import { within } from "@/test/utilities";

import { matchListTableHeadPage } from "./match-list-table-head.page";

describe("MatchListTableHead", () => {
  it("renders the Match, Players, Score, Status and Started column headers verbatim", () => {
    matchListTableHeadPage.render();

    expect(matchListTableHeadPage.getColumnHeader("Match")).toBeInTheDocument();
    expect(
      matchListTableHeadPage.getColumnHeader("Players"),
    ).toBeInTheDocument();
    expect(matchListTableHeadPage.getColumnHeader("Score")).toBeInTheDocument();
    expect(
      matchListTableHeadPage.getColumnHeader("Status"),
    ).toBeInTheDocument();
    expect(
      matchListTableHeadPage.getColumnHeader("Started"),
    ).toBeInTheDocument();
  });

  it("renders a trailing action column header with no label", () => {
    matchListTableHeadPage.render();

    // Six <th>; the last is the empty action column with no accessible name.
    const headers = within(matchListTableHeadPage.getHeaderRow()).getAllByRole(
      "columnheader",
    );
    expect(headers).toHaveLength(6);
    expect(headers[5]).toHaveTextContent("");
  });
});
