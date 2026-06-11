import { buildHeadToHeadMeetingView } from "./meeting-row.factory";
import { meetingRowPage } from "./meeting-row.page";

describe("MeetingRow", () => {
  it("shows the meeting date and the left–right games-won score", () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({
        dateLabel: "Apr 12",
        leftGamesWon: 3,
        rightGamesWon: 1,
      }),
    });

    expect(meetingRowPage.getDate()).toHaveTextContent(/^Apr 12$/);
    expect(meetingRowPage.getScore()).toHaveTextContent("3–1");
  });

  it("marks a left win with the win-toned score and a W result", () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({ leftWon: true }),
    });

    expect(meetingRowPage.getScore()).toHaveClass("md-h2h__score--win");
    const result = meetingRowPage.getResult();
    expect(result).toHaveTextContent(/^W$/);
    expect(result).toHaveClass("md-h2h__result--w");
    expect(result).not.toHaveClass("md-h2h__result--l");
  });

  it("marks a left loss without the win tone and an L result", () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({ leftWon: false }),
    });

    expect(meetingRowPage.getScore()).not.toHaveClass("md-h2h__score--win");
    const result = meetingRowPage.getResult();
    expect(result).toHaveTextContent(/^L$/);
    expect(result).toHaveClass("md-h2h__result--l");
    expect(result).not.toHaveClass("md-h2h__result--w");
  });
});
