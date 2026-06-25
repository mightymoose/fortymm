import { render, screen, type Container } from "@/test/utilities";

import {
  DisputeNoticeDisplay,
  type DisputeNoticeDisplayProps,
} from "./dispute-notice-display";
import { buildDisputeNoticeDisplayProps } from "./dispute-notice-display.factory";

const scoped = (container: Container) => ({
  /** The notice `<section>`; absent when the view projected to null upstream
   * (not disputed, viewer is the disputer, or a spectator). */
  queryNotice() {
    return container.queryByTestId("match-dispute-notice");
  },
  getNotice() {
    return container.getByTestId("match-dispute-notice");
  },
  /** The headline naming the disputer — "<name> disputed your result." */
  getHeadline() {
    return container.getByRole("heading", { name: /disputed your result/i });
  },
});

/** Test page-object for the pure `DisputeNoticeDisplay` — props in, DOM out,
 * no MSW. Embedding page objects (fetcher/wrapper) spread `within` to expose
 * the same notice queries as their own. */
export const disputeNoticeDisplayPage = {
  render(overrides: Partial<DisputeNoticeDisplayProps> = {}) {
    const props = buildDisputeNoticeDisplayProps(overrides);
    render(<DisputeNoticeDisplay {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
