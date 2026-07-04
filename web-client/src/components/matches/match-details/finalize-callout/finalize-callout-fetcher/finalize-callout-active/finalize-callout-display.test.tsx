import userEvent from "@testing-library/user-event";

import { finalizeCalloutDisplayPage } from "./finalize-callout-display.page";

describe("FinalizeCalloutDisplay", () => {
  it("invites the user to post the decided-but-unposted scores", () => {
    finalizeCalloutDisplayPage.render();

    const callout = finalizeCalloutDisplayPage.getCallout();
    expect(callout).toHaveTextContent("Scores ready · not yet posted");
    expect(callout).toHaveTextContent(
      "Post this result for your opponent to accept.",
    );
    expect(finalizeCalloutDisplayPage.getPostButton()).toHaveTextContent(
      "Post result",
    );
    expect(finalizeCalloutDisplayPage.getPostButton()).toBeEnabled();
    expect(finalizeCalloutDisplayPage.queryError()).not.toBeInTheDocument();
  });

  it("fires onPost when the CTA is clicked", async () => {
    const onPost = vi.fn();
    finalizeCalloutDisplayPage.render({ onPost });

    await userEvent.click(finalizeCalloutDisplayPage.getPostButton());

    expect(onPost).toHaveBeenCalledTimes(1);
  });

  it("disables the CTA and shows the in-flight label while pending", () => {
    finalizeCalloutDisplayPage.render({ pending: true });

    const button = finalizeCalloutDisplayPage.getPostButton();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Posting…");
  });

  it("surfaces an API failure inline so the button doesn't appear inert", () => {
    finalizeCalloutDisplayPage.render({
      errorMessage: "Result already posted",
    });

    expect(finalizeCalloutDisplayPage.queryError()).toHaveTextContent(
      "Result already posted",
    );
  });
});
