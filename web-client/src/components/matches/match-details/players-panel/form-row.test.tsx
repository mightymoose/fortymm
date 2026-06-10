import { buildFormRowView, buildLossFormRowView } from "./form-row.factory";
import { formRowPage } from "./form-row.page";

describe("FormRow", () => {
  it("badges a win with a W in the win tone", () => {
    formRowPage.render({ result: buildFormRowView({ won: true }) });

    const badge = formRowPage.getBadge("silva.r");
    expect(badge).toHaveTextContent("W");
    expect(badge).toHaveClass("md-form-row__badge--w");
    expect(badge).not.toHaveClass("md-form-row__badge--l");
  });

  it("badges a loss with an L in the loss tone", () => {
    formRowPage.render({ result: buildLossFormRowView() });

    const badge = formRowPage.getBadge("tanaka.y");
    expect(badge).toHaveTextContent("L");
    expect(badge).toHaveClass("md-form-row__badge--l");
  });

  it("names the opponent, titled for truncation, with the completion date", () => {
    formRowPage.render({
      result: buildFormRowView({
        opponentLabel: "silva.r",
        dateLabel: "May 9",
      }),
    });

    const row = formRowPage.getRow("silva.r");
    expect(row.querySelector(".md-form-row__opp")).toHaveAttribute(
      "title",
      "silva.r",
    );
    expect(formRowPage.getDate("silva.r")).toHaveTextContent("May 9");
  });

  it("shows the score plainly on a win", () => {
    formRowPage.render({ result: buildFormRowView({ scoreLabel: "3–1" }) });

    const score = formRowPage.getScore("silva.r");
    expect(score).toHaveTextContent("3–1");
    expect(score).not.toHaveClass("md-form-row__score--loss");
  });

  it("dims the score on a loss", () => {
    formRowPage.render({ result: buildLossFormRowView() });

    expect(formRowPage.getScore("tanaka.y")).toHaveClass(
      "md-form-row__score--loss",
    );
  });
});
