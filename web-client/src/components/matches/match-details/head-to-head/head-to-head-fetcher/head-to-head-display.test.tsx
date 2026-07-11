import { buildHeadToHeadView } from "./head-to-head-display.factory";
import { headToHeadDisplayPage } from "./head-to-head-display.page";
import { buildHeadToHeadMeetingView } from "./head-to-head-display/meeting-row.factory";

describe("HeadToHeadDisplay", () => {
  it("renders the card as a region named by its heading", async () => {
    headToHeadDisplayPage.render();

    await headToHeadDisplayPage.findCard();
    expect(headToHeadDisplayPage.getCard()).toBeInTheDocument();
    expect(headToHeadDisplayPage.getTitle()).toHaveTextContent("Head to head");
  });

  it("renders the panel through the shared Card, not the hand-rolled chrome", async () => {
    headToHeadDisplayPage.render();

    const card = await headToHeadDisplayPage.findCard();
    // The landmark must survive the reskin: the shared Card renders `asChild`,
    // so the styled card element *is* the labelled <section> — not an
    // anonymous <div> wrapping one.
    expect(card.tagName).toBe("SECTION");
    expect(card).toHaveAttribute("data-slot", "card");
    // Shared design-system chrome (hairline ring, rounded corners)…
    expect(card).toHaveClass("bg-card", "rounded-xl", "ring-1");
    // …and none of the bespoke `.md-card` family it replaced.
    expect(card).not.toHaveClass("md-card");
    expect(card.querySelector(".md-card__hd")).toBeNull();
    expect(card.querySelector(".md-card__body")).toBeNull();
    expect(card.querySelector(".md-card__hd-meta")).toBeNull();
  });

  it("shows the side labels and win counts", async () => {
    headToHeadDisplayPage.render();

    await headToHeadDisplayPage.findCard();
    expect(headToHeadDisplayPage.getLeftLabel()).toHaveTextContent(
      "rita.kovac",
    );
    expect(headToHeadDisplayPage.getRightLabel()).toHaveTextContent(
      "leo.mertens",
    );
    expect(headToHeadDisplayPage.getLeftCount()).toHaveTextContent(/^2$/);
    expect(headToHeadDisplayPage.getRightCount()).toHaveTextContent(/^1$/);
  });

  it("tones the leading side's count as the winner", async () => {
    headToHeadDisplayPage.render();

    await headToHeadDisplayPage.findCard();
    expect(headToHeadDisplayPage.getLeftCount()).toHaveClass(
      "md-h2h__count--win",
    );
    expect(headToHeadDisplayPage.getRightCount()).not.toHaveClass(
      "md-h2h__count--win",
    );
  });

  it("pluralizes the meeting count for several meetings", async () => {
    headToHeadDisplayPage.render();

    await headToHeadDisplayPage.findCard();
    expect(headToHeadDisplayPage.getMeta()).toHaveTextContent("3 MEETINGS");
  });

  it("singularizes the meeting count for a single meeting", async () => {
    headToHeadDisplayPage.render({
      headToHead: buildHeadToHeadView({ totalMeetings: 1 }),
    });

    await headToHeadDisplayPage.findCard();
    expect(headToHeadDisplayPage.getMeta()).toHaveTextContent("1 MEETING");
  });

  it("renders one row per recent meeting, with the bar, when there are meetings", async () => {
    headToHeadDisplayPage.render({
      headToHead: buildHeadToHeadView({
        recentMeetings: [
          buildHeadToHeadMeetingView({ matchId: "m-a", leftWon: false }),
          buildHeadToHeadMeetingView({ matchId: "m-b", leftWon: true }),
        ],
      }),
    });

    await headToHeadDisplayPage.findCard();
    expect(headToHeadDisplayPage.queryBar()).toBeInTheDocument();
    expect(headToHeadDisplayPage.queryEmpty()).not.toBeInTheDocument();
    expect(headToHeadDisplayPage.getRows()).toHaveLength(2);
    // Wiring only: row content is pinned by the meeting-row tests.
    expect(headToHeadDisplayPage.meeting(0).getLeftScore()).not.toHaveClass(
      "md-h2h__score-side--win",
    );
    expect(headToHeadDisplayPage.meeting(1).getLeftScore()).toHaveClass(
      "md-h2h__score-side--win",
    );
  });

  it("shows the start-of-rivalry empty state with no bar or rows", async () => {
    headToHeadDisplayPage.render({
      headToHead: buildHeadToHeadView({
        totalMeetings: 0,
        leftWins: 0,
        rightWins: 0,
        recentMeetings: [],
      }),
    });

    await headToHeadDisplayPage.findCard();
    expect(headToHeadDisplayPage.queryEmpty()).toHaveTextContent(
      /start of the rivalry/,
    );
    expect(headToHeadDisplayPage.queryBar()).not.toBeInTheDocument();
    expect(headToHeadDisplayPage.getRows()).toHaveLength(0);
  });
});
