import { render, screen, type Container } from "@/test/utilities";

import {
  RetirementCountdown,
  type RetirementCountdownProps,
} from "./retirement-countdown";
import { buildRetirementCountdownProps } from "./retirement-countdown.factory";

const scoped = (container: Container) => ({
  /** The countdown line (a `role="timer"`); absent when there's no deadline. */
  getCountdown() {
    return container.getByRole("timer");
  },
  queryCountdown() {
    return container.queryByRole("timer");
  },
  /** The escalating urgency band the countdown is rendered in
   * (`normal` | `soon` | `urgent` | `expired`), read off `data-tone`. */
  getTone() {
    return container.getByRole("timer").getAttribute("data-tone");
  },
});

/** Test page-object for `RetirementCountdown`. Pure view-in, DOM-out — no
 * router or MSW. The default props carry a three-days-out deadline. */
export const retirementCountdownPage = {
  render(overrides: Partial<RetirementCountdownProps> = {}) {
    const props = buildRetirementCountdownProps(overrides);
    render(<RetirementCountdown {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree, so parent page objects can reuse these queries.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
