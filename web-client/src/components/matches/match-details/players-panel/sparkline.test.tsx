import { sparklinePage } from "./sparkline.page";

describe("Sparkline", () => {
  it("draws a line through every data point with a marker on the last one", () => {
    sparklinePage.render({ data: [1480, 1465, 1490, 1510] });

    const path = sparklinePage.getTrendLine();
    // One M plus an L per remaining point.
    expect(path.getAttribute("d")).toMatch(/^M[\d. ]+(L[\d. ]+){3}$/);
    expect(sparklinePage.getEndpointDot()).not.toBeNull();
  });

  it("scales the points across the padded canvas, min to bottom and max to top", () => {
    // Two points over the default 110×36 canvas with 2px padding: the min
    // (0) sits at the bottom edge, the max (10) at the top, x spanning
    // pad → w-pad. Exact coordinates pin the scaling math.
    sparklinePage.render({ data: [0, 10] });

    expect(sparklinePage.getTrendLine()).toHaveAttribute(
      "d",
      "M2.0 34.0 L108.0 2.0",
    );
    const dot = sparklinePage.getEndpointDot();
    expect(dot).toHaveAttribute("cx", "108");
    expect(dot).toHaveAttribute("cy", "2");
    expect(dot).toHaveAttribute("r", "2.4");
  });

  it("renders at the requested dimensions", () => {
    sparklinePage.render({ data: [0, 10], w: 80, h: 28 });

    const svg = sparklinePage.getSparkline();
    expect(svg).toHaveAttribute("width", "80");
    expect(svg).toHaveAttribute("height", "28");
    expect(sparklinePage.getTrendLine()).toHaveAttribute(
      "d",
      "M2.0 26.0 L78.0 2.0",
    );
  });

  it("pins a flat series to the baseline instead of dividing by a zero range", () => {
    sparklinePage.render({ data: [1500, 1500] });

    expect(sparklinePage.getTrendLine()).toHaveAttribute(
      "d",
      "M2.0 34.0 L108.0 34.0",
    );
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

  it("reads a flat trend as up, not down", () => {
    sparklinePage.render({ data: [1500, 1480, 1500] });

    expect(sparklinePage.getTrendLine()).toHaveAttribute(
      "stroke",
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
