import { matchListSkeletonRowsPage } from "./match-list-skeleton-rows.page";

describe("MatchListSkeletonRows", () => {
  it("renders a table marked busy while the first page loads", () => {
    matchListSkeletonRowsPage.render();

    expect(matchListSkeletonRowsPage.getTable()).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("renders exactly six shimmer rows, each hidden from assistive tech", () => {
    // Wiring only: header columns are pinned by match-list-table-head tests.
    matchListSkeletonRowsPage.render();

    const rows =
      matchListSkeletonRowsPage.getTable().querySelectorAll("tr.skeleton-row");
    expect(rows).toHaveLength(6);
    rows.forEach((row: Element) => {
      expect(row).toHaveClass("skeleton-row");
      expect(row).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("spans every skeleton row across all six columns with a shimmer line", () => {
    matchListSkeletonRowsPage.render();

    const rows =
      matchListSkeletonRowsPage.getTable().querySelectorAll("tr.skeleton-row");
    rows.forEach((row: Element) => {
      const cell = row.querySelector("td");
      expect(cell).toHaveAttribute("colspan", "6");
      expect(cell?.querySelector("div.skeleton-line")).not.toBeNull();
    });
  });
});
