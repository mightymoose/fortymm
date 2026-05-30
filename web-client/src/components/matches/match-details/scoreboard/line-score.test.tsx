import { describe, it, expect } from "vitest";
import { HttpResponse, delay } from "msw";
import { matchDetails } from "@/test/factories";
import { lineScorePage } from "./line-score.page";

describe("LineScore", () => {
  it("shows the skeleton while the match loads, then swaps in the line score", async () => {
    const match = matchDetails({ id: "m-line", best_of: 5 });
    lineScorePage.mockEndpoint(async () => {
      await delay(50);
      return HttpResponse.json(match);
    });

    lineScorePage.render(match.id);

    // Suspense renders the skeleton until the request resolves...
    expect(lineScorePage.skeleton.placeholderCount).toBeGreaterThan(0);

    // ...then the real grid takes its place, labelling its columns for the
    // resolved best-of.
    await lineScorePage.data.settle();
    expect(lineScorePage.data.grid.columnLabels).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
    ]);
  });
});
