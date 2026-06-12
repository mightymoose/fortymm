import { render, screen, type Container } from "@/test/utilities";

import { Sparkline, type SparklineProps } from "./sparkline";
import { buildSparklineProps } from "./sparkline.factory";

const scoped = (container: Container) => ({
  /** The decorative trend svg; absent when the owner withholds the sparkline
   * (e.g. a rating box with fewer than two history points). The svg is
   * aria-hidden with no role or name, so a testid is the only handle. */
  getSparkline() {
    return container.getByTestId("match-details-sparkline");
  },
  querySparkline() {
    return container.queryByTestId("match-details-sparkline");
  },
  /** The trend line path inside the svg — its `stroke` carries the up/down
   * tone. */
  getTrendLine() {
    return container.getByTestId("match-details-sparkline").querySelector("path")!;
  },
  /** The endpoint marker dot at the last data point. */
  getEndpointDot() {
    return container
      .getByTestId("match-details-sparkline")
      .querySelector("circle")!;
  },
});

/**
 * Test page-object for `Sparkline` — the decorative rating-trend line. The
 * svg is aria-hidden, so accessors resolve it by testid; owners (the rating
 * box, the legacy rating card) spread `within` to expose the same queries.
 */
export const sparklinePage = {
  render(overrides: Partial<SparklineProps> = {}) {
    const props = buildSparklineProps(overrides);
    render(<Sparkline {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed this component spread
   * this to expose the same queries as their own, rather than re-deriving.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
