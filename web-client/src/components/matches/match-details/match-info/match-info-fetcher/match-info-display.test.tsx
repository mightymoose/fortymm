import { buildInfoRowView } from "./match-info-display/info-row.factory";
import { matchInfoDisplayPage } from "./match-info-display.page";

describe("MatchInfoDisplay", () => {
  it("renders the card as a region named by its Match info heading", () => {
    matchInfoDisplayPage.render();

    expect(matchInfoDisplayPage.getCard()).toBeInTheDocument();
    expect(matchInfoDisplayPage.getTitle()).toBeInTheDocument();
  });

  it("wears the shared design-system card, not the hand-rolled .md-card", () => {
    matchInfoDisplayPage.render();

    // `Card asChild` keeps the panel a labelled <section> landmark (asserted
    // above) while the chrome comes from the shared Card — same as the
    // dashboard's. The bespoke `.md-card` family is gone.
    const card = matchInfoDisplayPage.getCard();
    expect(card.tagName).toBe("SECTION");
    expect(card).toHaveAttribute("data-slot", "card");
    expect(card).toHaveClass("bg-card", "rounded-xl");
    expect(card).not.toHaveClass("md-card");
  });

  it("keeps the rows a description list inside the card's content slot", () => {
    matchInfoDisplayPage.render();

    // The rows are <dt>/<dd> pairs; `CardContent` has no `asChild`, so the <dl>
    // nests inside it rather than the list semantics being flattened away.
    const list = matchInfoDisplayPage.getRowList();
    expect(list.tagName).toBe("DL");
    expect(list.closest('[data-slot="card-content"]')).not.toBeNull();
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
