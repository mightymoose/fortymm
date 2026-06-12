import { buildHeadToHeadView } from "./head-to-head-display.factory";
import { headToHeadDisplayPage } from "./head-to-head-display.page";
import { buildHeadToHeadMeetingView } from "./head-to-head-display/meeting-row.factory";

describe("HeadToHeadDisplay", () => {
  it("renders the card as a region named by its heading", () => {
    headToHeadDisplayPage.render();

    expect(headToHeadDisplayPage.getCard()).toBeInTheDocument();
    expect(headToHeadDisplayPage.getTitle()).toHaveTextContent("Head to head");
  });

  it("shows the side labels and win counts", () => {
    headToHeadDisplayPage.render();

    expect(headToHeadDisplayPage.getLeftLabel()).toHaveTextContent(
      "rita.kovac",
    );
    expect(headToHeadDisplayPage.getRightLabel()).toHaveTextContent(
      "leo.mertens",
    );
    expect(headToHeadDisplayPage.getLeftCount()).toHaveTextContent(/^2$/);
    expect(headToHeadDisplayPage.getRightCount()).toHaveTextContent(/^1$/);
  });

  it("tones the leading side's count as the winner", () => {
    headToHeadDisplayPage.render();

    expect(headToHeadDisplayPage.getLeftCount()).toHaveClass(
      "md-h2h__count--win",
    );
    expect(headToHeadDisplayPage.getRightCount()).not.toHaveClass(
      "md-h2h__count--win",
    );
  });

  it("pluralizes the meeting count for several meetings", () => {
    headToHeadDisplayPage.render();

    expect(headToHeadDisplayPage.getMeta()).toHaveTextContent("3 MEETINGS");
  });

  it("singularizes the meeting count for a single meeting", () => {
    headToHeadDisplayPage.render({
      headToHead: buildHeadToHeadView({ totalMeetings: 1 }),
    });

    expect(headToHeadDisplayPage.getMeta()).toHaveTextContent("1 MEETING");
  });

  it("renders one row per recent meeting, with the bar, when there are meetings", () => {
    headToHeadDisplayPage.render({
      headToHead: buildHeadToHeadView({
        recentMeetings: [
          buildHeadToHeadMeetingView({ matchId: "m-a", leftWon: false }),
          buildHeadToHeadMeetingView({ matchId: "m-b", leftWon: true }),
        ],
      }),
    });

    expect(headToHeadDisplayPage.queryBar()).toBeInTheDocument();
    expect(headToHeadDisplayPage.queryEmpty()).not.toBeInTheDocument();
    expect(headToHeadDisplayPage.getRows()).toHaveLength(2);
    // Wiring only: row content is pinned by the meeting-row tests.
    expect(headToHeadDisplayPage.meeting(0).getResult()).toHaveTextContent(
      /^L$/,
    );
    expect(headToHeadDisplayPage.meeting(1).getResult()).toHaveTextContent(
      /^W$/,
    );
  });

  it("shows the start-of-rivalry empty state with no bar or rows", () => {
    headToHeadDisplayPage.render({
      headToHead: buildHeadToHeadView({
        totalMeetings: 0,
        leftWins: 0,
        rightWins: 0,
        recentMeetings: [],
      }),
    });

    expect(headToHeadDisplayPage.queryEmpty()).toHaveTextContent(
      /start of the rivalry/,
    );
    expect(headToHeadDisplayPage.queryBar()).not.toBeInTheDocument();
    expect(headToHeadDisplayPage.getRows()).toHaveLength(0);
  });
});
