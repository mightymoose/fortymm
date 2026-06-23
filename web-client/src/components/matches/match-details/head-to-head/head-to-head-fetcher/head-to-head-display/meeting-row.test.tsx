import { buildHeadToHeadMeetingView } from "./meeting-row.factory";
import { meetingRowPage } from "./meeting-row.page";

describe("MeetingRow", () => {
  it("shows the meeting date and the left–right games-won score", async () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({
        dateLabel: "Apr 12",
        leftGamesWon: 3,
        rightGamesWon: 1,
      }),
    });

    await meetingRowPage.findRow();
    expect(meetingRowPage.getDate()).toHaveTextContent(/^Apr 12$/);
    expect(meetingRowPage.getScore()).toHaveTextContent("3–1");
  });

  it("links the row to the meeting's match-detail page", async () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({ matchId: "m-42", dateLabel: "Apr 12" }),
    });

    const row = await meetingRowPage.findRow();
    expect(row.tagName).toBe("A");
    expect(row).toHaveAttribute("href", "/matches/m-42");
    expect(row).toHaveAttribute("aria-label", "Open match from Apr 12");
  });

  it("marks a rated meeting with the Rated tag and omits it when unrated", async () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({ rated: true }),
    });

    await meetingRowPage.findRow();
    expect(meetingRowPage.getRatedTag()).toHaveTextContent(/^Rated$/);
  });

  it("omits the Rated tag for an unrated meeting", async () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({ rated: false }),
    });

    await meetingRowPage.findRow();
    expect(meetingRowPage.getRatedTag()).toBeNull();
  });

  it("marks a left win with the win-toned score and a W result", async () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({ leftWon: true }),
    });

    await meetingRowPage.findRow();
    expect(meetingRowPage.getScore()).toHaveClass("md-h2h__score--win");
    const result = meetingRowPage.getResult();
    expect(result).toHaveTextContent(/^W$/);
    expect(result).toHaveClass("md-h2h__result--w");
    expect(result).not.toHaveClass("md-h2h__result--l");
  });

  it("marks a left loss without the win tone and an L result", async () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({ leftWon: false }),
    });

    await meetingRowPage.findRow();
    expect(meetingRowPage.getScore()).not.toHaveClass("md-h2h__score--win");
    const result = meetingRowPage.getResult();
    expect(result).toHaveTextContent(/^L$/);
    expect(result).toHaveClass("md-h2h__result--l");
    expect(result).not.toHaveClass("md-h2h__result--w");
  });

  it("shows a neutral dash with no outcome class when winner is unknown", async () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({ leftWon: null }),
    });

    await meetingRowPage.findRow();
    expect(meetingRowPage.getScore()).not.toHaveClass("md-h2h__score--win");
    const result = meetingRowPage.getResult();
    expect(result).toHaveTextContent(/^–$/);
    expect(result).not.toHaveClass("md-h2h__result--w");
    expect(result).not.toHaveClass("md-h2h__result--l");
  });
});
