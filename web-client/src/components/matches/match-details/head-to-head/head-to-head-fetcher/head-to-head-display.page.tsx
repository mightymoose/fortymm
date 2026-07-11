import { renderUnderMatchRoute } from "@/test/match-route";
import { screen, within, type Container } from "@/test/utilities";

import {
  HeadToHeadDisplay,
  type HeadToHeadDisplayProps,
} from "./head-to-head-display";
import { buildHeadToHeadDisplayProps } from "./head-to-head-display.factory";
import { meetingRowPage } from "./head-to-head-display/meeting-row.page";

const scoped = (container: Container) => {
  const getCard = () =>
    container.getByRole("region", { name: "Head to head" });
  const getRows = () =>
    Array.from(getCard().querySelectorAll(".md-h2h__row")) as HTMLElement[];

  return {
    /** The card's `<section>` landmark, named by its visible heading. */
    getCard,
    /** Async variant — the card mounts under a router that resolves the rows'
     * typed links asynchronously, so first reads should await this. */
    findCard() {
      return container.findByRole("region", { name: "Head to head" });
    },
    queryCard() {
      return container.queryByRole("region", { name: "Head to head" });
    },
    /** The visible card heading. */
    getTitle() {
      return container.getByRole("heading", {
        level: 3,
        name: "Head to head",
      });
    },
    /** The "N MEETING(S)" count in the shared Card's trailing header slot. */
    getMeta() {
      return getCard().querySelector('[data-slot="card-action"]')!;
    },
    /** The left side's player-name label. */
    getLeftLabel() {
      return getCard().querySelector(".md-h2h__count-label--l")!;
    },
    /** The right side's player-name label. */
    getRightLabel() {
      return getCard().querySelector(".md-h2h__count-label--r")!;
    },
    /** The left side's win count — `--win` modifier when it leads. */
    getLeftCount() {
      return getCard().querySelector(".md-h2h__count--l")!;
    },
    /** The right side's win count — `--win` modifier when it leads. */
    getRightCount() {
      return getCard().querySelector(".md-h2h__count--r")!;
    },
    /** The win-share bar; absent on a no-meetings card. */
    queryBar() {
      return getCard().querySelector(".md-h2h__bar");
    },
    /** The "start of the rivalry" empty state; absent once there are
     * meetings. */
    queryEmpty() {
      return getCard().querySelector(".md-h2h__empty");
    },
    /** Every meeting row, newest first. */
    getRows,
    /** The meeting-row accessors scoped to the row at `index`. */
    meeting(index: number) {
      return meetingRowPage.within(within(getRows()[index]) as Container);
    },
  };
};

/**
 * Test page-object for `HeadToHeadDisplay` — the pure view-in, DOM-out
 * head-to-head card. Use `meeting(index)` to assert within one prior meeting's
 * row.
 */
export const headToHeadDisplayPage = {
  render(overrides: Partial<HeadToHeadDisplayProps> = {}) {
    const props = buildHeadToHeadDisplayProps(overrides);
    renderUnderMatchRoute(<HeadToHeadDisplay {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. The fetcher and wrapper page objects spread this
   * to expose the same queries as their own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
