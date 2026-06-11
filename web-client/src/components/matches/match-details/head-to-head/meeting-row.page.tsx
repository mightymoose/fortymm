import { render, screen, type Container } from "@/test/utilities";

import { MeetingRow, type MeetingRowProps } from "./meeting-row";
import { buildMeetingRowProps } from "./meeting-row.factory";

const scoped = (container: Container) => {
  const getRow = () =>
    container
      .getByText("Match", { selector: ".md-h2h__label" })
      .closest(".md-h2h__row") as HTMLElement;

  return {
    /** The meeting's row element. A scoped container holds a single row, so
     * there's no per-row discriminator — the embedding page object scopes to
     * one row before reaching for these. */
    getRow,
    /** The pre-formatted meeting date. */
    getDate() {
      return getRow().querySelector(".md-h2h__date")!;
    },
    /** The "left–right" games-won score; its `--win` modifier marks a left
     * win. */
    getScore() {
      return getRow().querySelector(".md-h2h__score")!;
    },
    /** The W/L marker; its `--w`/`--l` modifier carries the win/loss tone. */
    getResult() {
      return getRow().querySelector(".md-h2h__result")!;
    },
  };
};

/**
 * Test page-object for `MeetingRow` — one prior meeting's line in the
 * head-to-head card. A scoped container holds exactly one row, so accessors
 * take no discriminator; the head-to-head display scopes to a single row
 * element before spreading these.
 */
export const meetingRowPage = {
  render(overrides: Partial<MeetingRowProps> = {}) {
    const props = buildMeetingRowProps(overrides);
    render(<MeetingRow {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. The display page object scopes this to one row's
   * element to read that meeting's parts.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
