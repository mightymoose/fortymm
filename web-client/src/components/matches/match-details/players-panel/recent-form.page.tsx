import { render, screen, type Container } from "@/test/utilities";

import { formRowPage } from "./form-row.page";
import { RecentForm, type RecentFormProps } from "./recent-form";
import { buildRecentFormProps } from "./recent-form.factory";

const scoped = (container: Container) => ({
  /** The block's kicker — "Form" on the empty branch, "Form · W–L" with
   * history. Scoped to the form block: a profile has sibling kickers
   * (Rating, Career matches, Win rate). */
  getFormKicker(text: string) {
    return container.getByText(text, {
      selector: ".md-profile__form > .md-kicker",
    });
  },
  /** The one-line career summary above the rows; absent on the empty branch. */
  getFormSummary(text: string) {
    return container.getByText(text, {
      selector: ".md-profile__form-summary",
    });
  },
  queryFormSummary(text: string) {
    return container.queryByText(text, {
      selector: ".md-profile__form-summary",
    });
  },
  /** The "No prior matches yet…" sentence; absent when history exists. */
  getFirstMatchNote(text: string | RegExp) {
    return container.getByText(text, {
      selector: ".md-profile__form .md-profile__empty",
    });
  },
  queryFirstMatchNote(text: string | RegExp) {
    return container.queryByText(text, {
      selector: ".md-profile__form .md-profile__empty",
    });
  },
  /** The result list itself; absent on the empty branch. */
  queryFormList() {
    return container.queryByRole("list");
  },
  ...formRowPage.within(container),
});

/**
 * Test page-object for `RecentForm` — the form block in the middle of a
 * profile: the empty "first one" sentence, or the W–L kicker + career summary
 * + recent result rows.
 */
export const recentFormPage = {
  render(overrides: Partial<RecentFormProps> = {}) {
    const props = buildRecentFormProps(overrides);
    render(<RecentForm {...props} />);
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
