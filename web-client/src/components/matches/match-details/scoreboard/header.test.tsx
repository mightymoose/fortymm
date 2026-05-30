import { describe, it, expect } from "vitest";
import { HttpResponse, delay } from "msw";
import { matchDetails } from "@/test/factories";
import { headerPage } from "./header.page";

describe("Header", () => {
  it("shows the skeleton while the match loads, then swaps in the header data", async () => {
    const match = matchDetails({ id: "m-header" });
    headerPage.mockEndpoint(async () => {
      await delay(50);
      return HttpResponse.json(match);
    });

    headerPage.render(match.id);

    // Suspense renders the skeleton until the request resolves...
    expect(headerPage.skeleton.isBusy).toBe(true);

    // ...then the real header strip takes its place, rendering the resolved
    // match — the default in-progress fixture maps to the live badge.
    await headerPage.data.settle();
    expect(headerPage.data.meta.status).toBe("Live · Game 1");
  });
});
