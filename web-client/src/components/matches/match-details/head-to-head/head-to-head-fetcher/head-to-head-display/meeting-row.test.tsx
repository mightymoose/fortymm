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

  it("tints the left side's score when the left side won", async () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({
        leftGamesWon: 3,
        rightGamesWon: 1,
        leftWon: true,
      }),
    });

    await meetingRowPage.findRow();
    expect(meetingRowPage.getLeftScore()).toHaveClass("md-h2h__score-side--win");
    expect(meetingRowPage.getRightScore()).not.toHaveClass(
      "md-h2h__score-side--win",
    );
    // Anchor each side's identity to the count it displays: the class
    // assertions above would still pass if the `--l`/`--r` classes and the win
    // conditions were swapped together, which tints the wrong number.
    expect(meetingRowPage.getLeftScore()).toHaveTextContent(/^3$/);
    expect(meetingRowPage.getRightScore()).toHaveTextContent(/^1$/);
  });

  it("tints the right side's score when the right side won", async () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({
        leftGamesWon: 1,
        rightGamesWon: 3,
        leftWon: false,
      }),
    });

    await meetingRowPage.findRow();
    expect(meetingRowPage.getRightScore()).toHaveClass(
      "md-h2h__score-side--win",
    );
    expect(meetingRowPage.getLeftScore()).not.toHaveClass(
      "md-h2h__score-side--win",
    );
    expect(meetingRowPage.getLeftScore()).toHaveTextContent(/^1$/);
    expect(meetingRowPage.getRightScore()).toHaveTextContent(/^3$/);
  });

  it("tints neither side and shows a No result tag when no winner was recorded", async () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({ leftWon: null }),
    });

    await meetingRowPage.findRow();
    expect(meetingRowPage.getLeftScore()).not.toHaveClass(
      "md-h2h__score-side--win",
    );
    expect(meetingRowPage.getRightScore()).not.toHaveClass(
      "md-h2h__score-side--win",
    );
    expect(meetingRowPage.getNoResultTag()).toHaveTextContent(/^No result$/);
  });

  it("omits the No result tag for a decided meeting", async () => {
    meetingRowPage.render({
      meeting: buildHeadToHeadMeetingView({ leftWon: true }),
    });

    await meetingRowPage.findRow();
    expect(meetingRowPage.getNoResultTag()).toBeNull();
  });
});
