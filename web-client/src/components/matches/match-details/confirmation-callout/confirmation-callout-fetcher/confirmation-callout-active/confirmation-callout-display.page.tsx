import { render, screen, type Container } from "@/test/utilities";

import {
  ConfirmationCalloutDisplay,
  type ConfirmationCalloutDisplayProps,
} from "./confirmation-callout-display";
import { buildConfirmationCalloutDisplayProps } from "./confirmation-callout-display.factory";

const scoped = (container: Container) => ({
  /** The callout `<section>` (either variant); absent when the view projected
   * to null upstream. */
  queryCallout() {
    return container.queryByTestId("match-confirm-callout");
  },
  getCallout() {
    return container.getByTestId("match-confirm-callout");
  },
  /** The featured variant's primary CTA — "Accept result" idle, "Accepting…"
   * in flight. Absent on the passive variant. */
  getAcceptButton() {
    return container.getByRole("button", { name: /accept/i });
  },
  queryAcceptButton() {
    return container.queryByRole("button", { name: /accept/i });
  },
  /** The inline API-failure line beneath the body copy; null when clean. */
  queryError() {
    return container.queryByRole("alert");
  },
});

/** Test page-object for the pure `ConfirmationCalloutDisplay` — props in,
 * DOM out, no MSW. Embedding page objects (active/fetcher/wrapper) spread
 * `within` to expose the same callout queries as their own. */
export const confirmationCalloutDisplayPage = {
  render(overrides: Partial<ConfirmationCalloutDisplayProps> = {}) {
    const props = buildConfirmationCalloutDisplayProps(overrides);
    render(<ConfirmationCalloutDisplay {...props} />);
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
