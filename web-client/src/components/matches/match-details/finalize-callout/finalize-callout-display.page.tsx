import { render, screen, type Container } from "@/test/utilities";

import {
  FinalizeCalloutDisplay,
  type FinalizeCalloutDisplayProps,
} from "./finalize-callout-display";
import { buildFinalizeCalloutDisplayProps } from "./finalize-callout-display.factory";

const scoped = (container: Container) => ({
  /** The callout `<section>`; absent when the view projected to null upstream. */
  queryCallout() {
    return container.queryByTestId("match-finalize-callout");
  },
  getCallout() {
    return container.getByTestId("match-finalize-callout");
  },
  /** The single CTA — labelled "Post result" idle, "Posting…" in flight. */
  getPostButton() {
    return container.getByRole("button");
  },
  /** The inline API-failure line beneath the body copy; null when clean. */
  queryError() {
    return container.queryByRole("alert");
  },
});

/** Test page-object for the pure `FinalizeCalloutDisplay` — props in, DOM
 * out, no MSW. Embedding page objects (active/fetcher/wrapper) spread
 * `within` to expose the same callout queries as their own. */
export const finalizeCalloutDisplayPage = {
  render(overrides: Partial<FinalizeCalloutDisplayProps> = {}) {
    const props = buildFinalizeCalloutDisplayProps(overrides);
    render(<FinalizeCalloutDisplay {...props} />);
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
