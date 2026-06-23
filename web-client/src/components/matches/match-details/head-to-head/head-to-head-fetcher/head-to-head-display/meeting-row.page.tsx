import { renderUnderMatchRoute } from "@/test/match-route";
import { screen, type Container } from "@/test/utilities";

import { MeetingRow, type MeetingRowProps } from "./meeting-row";
import { buildMeetingRowProps } from "./meeting-row.factory";

const scoped = (container: Container) => {
  const getRow = () =>
    container
      .getByText("Match", { selector: ".md-h2h__label" })
      .closest(".md-h2h__row") as HTMLElement;
  const findRow = async () => {
    const label = await container.findByText("Match", {
      selector: ".md-h2h__label",
    });
    return label.closest(".md-h2h__row") as HTMLElement;
  };

  return {
    /** The meeting's row element — a typed `<Link>` to the match. A scoped
     * container holds a single row, so there's no per-row discriminator; the
     * embedding page object scopes to one row before reaching for these. */
    getRow,
    /** Async variant — the row mounts under a router that resolves the typed
     * link asynchronously, so first reads should await this. */
    findRow,
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
    /** The "Rated" marker, or `null` for an unrated meeting. */
    getRatedTag() {
      return getRow().querySelector(".md-h2h__tag");
    },
  };
};

/**
 * Test page-object for `MeetingRow` — one prior meeting's line in the
 * head-to-head card. The row is a typed `<Link>`, so `render` mounts it under
 * a minimal router that registers the match-detail route the row targets; the
 * router resolves asynchronously, so first reads should `await findRow()`. A
 * scoped container holds exactly one row, so accessors take no discriminator;
 * the head-to-head display scopes to a single row element before spreading
 * these.
 */
export const meetingRowPage = {
  render(overrides: Partial<MeetingRowProps> = {}) {
    const props = buildMeetingRowProps(overrides);
    renderUnderMatchRoute(<MeetingRow {...props} />);
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
