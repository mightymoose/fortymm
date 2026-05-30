import { describe, it, expect } from "vitest";
import { metaPage } from "./meta.page";
import { metaFactory } from "./meta.factory";

describe("Meta", () => {
  it("shows the singles / best-of format", () => {
    metaPage.render(metaFactory({ bestOf: 7 }));

    expect(metaPage.format).toBe("SINGLES · BO7");
  });

  it("shows how many games win the match once it is under way", () => {
    metaPage.render(metaFactory({ status: { kind: "final" }, bestOf: 5 }));

    expect(metaPage.firstTo).toBe(3);
  });

  it("rounds the games-to-win up for odd best-of lengths", () => {
    metaPage.render(metaFactory({ status: { kind: "live", gameNumber: 1 }, bestOf: 3 }));

    expect(metaPage.firstTo).toBe(2);
  });

  it("hides the games-to-win for an upcoming match", () => {
    metaPage.render(
      metaFactory({ status: { kind: "upcoming", label: "Sat 10am" }, bestOf: 5 }),
    );

    expect(metaPage.firstTo).toBeNull();
  });

  it("shows the live status badge with its game number", () => {
    metaPage.render(metaFactory({ status: { kind: "live", gameNumber: 3 } }));

    expect(metaPage.status).toBe("Live · Game 3");
  });

  it("shows the final status badge", () => {
    metaPage.render(metaFactory({ status: { kind: "final" } }));

    expect(metaPage.status).toBe("Final");
  });

  it("shows the upcoming status badge", () => {
    metaPage.render(
      metaFactory({ status: { kind: "upcoming", label: "Sat 10am" } }),
    );

    expect(metaPage.status).toBe("Upcoming");
  });

  it("shows the awaiting-confirmation status badge", () => {
    metaPage.render(metaFactory({ status: { kind: "awaiting-confirmation" } }));

    expect(metaPage.status).toBe("Awaiting confirmation");
  });
});
