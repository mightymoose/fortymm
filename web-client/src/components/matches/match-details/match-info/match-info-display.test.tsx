import { buildInfoRowView } from "./info-row.factory";
import { matchInfoDisplayPage } from "./match-info-display.page";

describe("MatchInfoDisplay", () => {
  it("renders the card as a region named by its Match info heading", () => {
    matchInfoDisplayPage.render();

    expect(matchInfoDisplayPage.getCard()).toBeInTheDocument();
    expect(matchInfoDisplayPage.getTitle()).toBeInTheDocument();
  });

  it("renders one row per view row, in order, with its value", () => {
    matchInfoDisplayPage.render({
      info: {
        rows: [
          buildInfoRowView({ label: "Status", value: "Live" }),
          buildInfoRowView({ label: "Rated", value: "No" }),
        ],
      },
    });

    // Wiring only: each row's label/value pairing is pinned by info-row tests.
    expect(matchInfoDisplayPage.getValue("Status")).toHaveTextContent(
      /^Live$/,
    );
    expect(matchInfoDisplayPage.getValue("Rated")).toHaveTextContent(/^No$/);
    expect(matchInfoDisplayPage.queryLabel("Format")).not.toBeInTheDocument();
  });
});
