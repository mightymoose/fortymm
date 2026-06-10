import { sparklinePage } from "./sparkline.page";

describe("Sparkline", () => {
  it("draws a line through every data point with a marker on the last one", () => {
    sparklinePage.render({ data: [1480, 1465, 1490, 1510] });

    const path = sparklinePage.getTrendLine();
    // One M plus an L per remaining point.
    expect(path.getAttribute("d")).toMatch(/^M[\d. ]+(L[\d. ]+){3}$/);
    expect(sparklinePage.getEndpointDot()).not.toBeNull();
  });

  it("colors an upward trend with the serve tone", () => {
    sparklinePage.render({ data: [1480, 1465, 1490, 1510] });

    expect(sparklinePage.getTrendLine()).toHaveAttribute(
      "stroke",
      "var(--serve-500)",
    );
    expect(sparklinePage.getEndpointDot()).toHaveAttribute(
      "fill",
      "var(--serve-500)",
    );
  });

  it("colors a downward trend with the muted default", () => {
    sparklinePage.render({ data: [1510, 1490, 1480] });

    expect(sparklinePage.getTrendLine()).toHaveAttribute(
      "stroke",
      "var(--fg-3)",
    );
  });

  it("honors a custom down color", () => {
    sparklinePage.render({
      data: [1510, 1480],
      downColor: "var(--loss)",
    });

    expect(sparklinePage.getTrendLine()).toHaveAttribute(
      "stroke",
      "var(--loss)",
    );
  });

  it("stays out of the accessibility tree — the rating value carries the info", () => {
    sparklinePage.render();

    expect(sparklinePage.getSparkline()).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
