import { render, screen, type Container } from "@/test/utilities";

import { infoRowPage } from "./match-info-display/info-row.page";
import {
  MatchInfoDisplay,
  type MatchInfoDisplayProps,
} from "./match-info-display";
import { buildMatchInfoDisplayProps } from "./match-info-display.factory";

/**
 * A structural fingerprint of a panel's *card chrome*: the card element itself
 * plus its immediate slots (header, content). Deliberately blind to the bits
 * the skeleton and the loaded panel are supposed to differ on — role,
 * accessible name, leaf content — so it can pin the one thing they must agree
 * on: the box the panel occupies. `MatchInfoSkeleton`'s page object reuses it,
 * and the skeleton test compares the two fingerprints, which is what stops the
 * skeleton and the loaded card from drifting into different-shaped boxes.
 */
export const cardChrome = (card: Element) => ({
  tag: card.tagName,
  slot: card.getAttribute("data-slot"),
  className: card.className,
  slots: Array.from(card.children).map((child) => ({
    tag: child.tagName,
    slot: child.getAttribute("data-slot"),
    className: child.className,
  })),
});

const scoped = (container: Container) => ({
  /** The card's `<section>` landmark, named by its visible heading. */
  getCard() {
    return container.getByRole("region", { name: "Match info" });
  },
  queryCard() {
    return container.queryByRole("region", { name: "Match info" });
  },
  /** The loaded panel's card chrome — see {@link cardChrome}. */
  getCardChrome() {
    return cardChrome(this.getCard());
  },
  /** The visible card heading. */
  getTitle() {
    return container.getByRole("heading", { level: 3, name: "Match info" });
  },
  /** The `<dl>` holding the rows. Queried by tag: a description list has no
   * role of its own, and its list semantics are the thing under test. */
  getRowList() {
    const list = this.getCard().querySelector("dl");
    if (!list) throw new Error("No <dl> of info rows inside the card");
    return list;
  },
  // Row lookups (`getLabel(label)` / `getValue(label)`) come from the row's
  // own page object.
  ...infoRowPage.within(container),
});

/**
 * Test page-object for `MatchInfoDisplay` — the pure view-in, DOM-out
 * sidebar card. Use `getValue(label)` to assert a row's value.
 */
export const matchInfoDisplayPage = {
  render(overrides: Partial<MatchInfoDisplayProps> = {}) {
    const props = buildMatchInfoDisplayProps(overrides);
    render(<MatchInfoDisplay {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. The fetcher and wrapper page objects spread this
   * to expose the same queries as their own, rather than re-deriving.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
