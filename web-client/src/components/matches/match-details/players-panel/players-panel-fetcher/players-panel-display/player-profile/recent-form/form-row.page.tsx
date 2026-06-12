import { render, screen, within, type Container } from "@/test/utilities";

import { FormRow, type FormRowProps } from "./form-row";
import { buildFormRowProps } from "./form-row.factory";

const scoped = (container: Container) => {
  const getRow = (opponentLabel: string) =>
    container
      .getByText(opponentLabel, { selector: ".md-form-row__opp-name" })
      .closest("li")!;

  return {
    /** The whole `<li>` for the row naming `opponentLabel` — rows in a list
     * are distinguished by their opponent, same as a reader scans them. */
    getRow,
    queryRow(opponentLabel: string) {
      return (
        container
          .queryByText(opponentLabel, { selector: ".md-form-row__opp-name" })
          ?.closest("li") ?? null
      );
    },
    /** That row's W/L badge. */
    getBadge(opponentLabel: string) {
      return within(getRow(opponentLabel)).getByText(/^[WL]$/, {
        selector: ".md-form-row__badge",
      });
    },
    /** That row's completion date, e.g. "May 9". */
    getDate(opponentLabel: string) {
      return getRow(opponentLabel).querySelector(".md-form-row__when")!;
    },
    /** That row's player-perspective score, e.g. "3–1". */
    getScore(opponentLabel: string) {
      return getRow(opponentLabel).querySelector(".md-form-row__score")!;
    },
  };
};

/**
 * Test page-object for `FormRow` — one past result in a profile's recent-form
 * list. `render` mounts the `<li>` inside a bare `<ul>` so the markup stays
 * valid; accessors take the row's opponent label, since that's how rows in a
 * list differ.
 */
export const formRowPage = {
  render(overrides: Partial<FormRowProps> = {}) {
    const props = buildFormRowProps(overrides);
    render(
      <ul>
        <FormRow {...props} />
      </ul>,
    );
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
