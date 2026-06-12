import { render, screen, type Container } from "@/test/utilities";

import { InfoRow, type InfoRowProps } from "./info-row";
import { buildInfoRowProps } from "./info-row.factory";

const scoped = (container: Container) => ({
  /** The row's label cell (the `<dt>`), found by its text, e.g. "Format". */
  getLabel(label: string) {
    return container.getByText(label, { selector: ".md-info-row__k" });
  },
  queryLabel(label: string) {
    return container.queryByText(label, { selector: ".md-info-row__k" });
  },
  /** The value cell (the `<dd>`) paired with the row labelled `label`. */
  getValue(label: string) {
    const row = scoped(container)
      .getLabel(label)
      .closest(".md-info-row") as HTMLElement;
    const value = row.querySelector(".md-info-row__v");
    if (!value) {
      throw new Error(`Row "${label}" has no value cell`);
    }
    return value as HTMLElement;
  },
});

/**
 * Test page-object for `InfoRow` — one label/value line of the match-info
 * card. Rows are told apart by their label text, the same way a reader does.
 */
export const infoRowPage = {
  render(overrides: Partial<InfoRowProps> = {}) {
    const props = buildInfoRowProps(overrides);
    render(
      <dl>
        <InfoRow {...props} />
      </dl>,
    );
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed rows (the display, the
   * fetcher) spread this to expose the same queries as their own.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
