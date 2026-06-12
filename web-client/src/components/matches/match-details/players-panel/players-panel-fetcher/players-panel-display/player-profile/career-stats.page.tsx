import { render, screen, type Container } from "@/test/utilities";

import { CareerStats, type CareerStatsProps } from "./career-stats";
import { buildCareerStatsProps } from "./career-stats.factory";

const scoped = (container: Container) => {
  // Each stat cell pairs a kicker label with a value div — resolve the value
  // through its label, the same way a reader pairs them.
  const valueFor = (label: string) =>
    container
      .getByText(label, { selector: ".md-profile__career .md-kicker" })
      .parentElement!.querySelector(".md-profile__career-value")!;

  return {
    /** The "Career matches" count. */
    getCareerMatches() {
      return valueFor("Career matches");
    },
    /** The "Win rate" value — a percentage, or the dim em dash with no
     * career matches. */
    getWinRate() {
      return valueFor("Win rate");
    },
  };
};

/**
 * Test page-object for `CareerStats` — the career strip at the bottom of a
 * profile. Accessors resolve each value through its kicker label.
 */
export const careerStatsPage = {
  render(overrides: Partial<CareerStatsProps> = {}) {
    const props = buildCareerStatsProps(overrides);
    render(<CareerStats {...props} />);
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
