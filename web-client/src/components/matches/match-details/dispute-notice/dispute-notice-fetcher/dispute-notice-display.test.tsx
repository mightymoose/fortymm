import { buildDisputeNoticeView } from "./dispute-notice-display.factory";
import { disputeNoticeDisplayPage } from "./dispute-notice-display.page";

describe("DisputeNoticeDisplay", () => {
  it("names the disputer in the headline", () => {
    disputeNoticeDisplayPage.render({
      view: buildDisputeNoticeView({ disputerName: "leo.mertens" }),
    });

    expect(disputeNoticeDisplayPage.getHeadline()).toHaveTextContent(
      "leo.mertens disputed your result.",
    );
  });

  it("tells the submitter to re-score and re-post", () => {
    disputeNoticeDisplayPage.render();

    expect(disputeNoticeDisplayPage.getNotice()).toHaveTextContent(
      "Re-score the wrong game and post the result again to send it back for sign-off.",
    );
  });

  it("renders as the featured callout variant", () => {
    disputeNoticeDisplayPage.render();

    expect(disputeNoticeDisplayPage.getNotice()).toHaveClass(
      "md-confirm-callout--featured",
    );
  });
});
