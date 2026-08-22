/**
 * The tournaments list's search box follows the URL when the URL changes underneath
 * it — pinned in a real browser, where the mid-keystroke render exists (#1420).
 *
 * The box holds its own raw text buffer, seeded from the URL. The app shell's sidebar
 * entry is `to: '/tournaments'` with no search, so clicking it while a search is active
 * is a SAME-ROUTE navigation: the URL drops `q`, the page never unmounts, and without a
 * resync the box kept its text and the grid stayed filtered (#970, repaired in
 * `b4a8c2d7`).
 *
 * The repair keys the resync on the PREVIOUS url value. The plausible wrong version
 * keys it on a bare mismatch between the URL and the box — and a mismatch is the
 * normal mid-keystroke state, because `changeQuery` sets the buffer synchronously and
 * `navigate` commits the URL a render later. That version eats the character just
 * typed. vitest cannot see it: `userEvent.type` flushes `act` between keystrokes, so
 * jsdom never renders the stale-URL state and every test there is green against both
 * versions. Only a real browser reaches that render, so the guard lives here.
 *
 * Per-character typing throughout, never `fill()`: a `fill` sets the whole value in
 * one event and produces no mid-keystroke render to assert on.
 */
import { expect, test } from "@playwright/test";

import { TournamentsListPage } from "../page-objects/tournaments/tournaments-list.page";

/** The store's one seeded tournament, by the name the organizer reads. */
const SEEDED = "Bay Area Open 2026";

/** A search the seeded name cannot match, so the grid visibly narrows to nothing —
 * and the card coming back is the grid visibly unfiltering. */
const NO_MATCH = "zzz";

test.describe("tournaments list — the search box follows the URL", () => {
  test("a same-route navigation that drops q clears the box and the grid", async ({
    page,
  }) => {
    const { pom } = await TournamentsListPage.navigateTo(page);
    await expect(pom.card(SEEDED)).toBeVisible();

    await pom.searchInput.pressSequentially(NO_MATCH);
    await expect(pom.searchInput).toHaveValue(NO_MATCH);
    await expect(page).toHaveURL(/[?&]q=zzz(&|$)/);
    await expect(pom.card(SEEDED)).toHaveCount(0);

    // The navigation that produced the bug: the shell's own link, same route, no search.
    await pom.sidebarTournamentsLink.click();
    await expect(page).not.toHaveURL(/[?&]q=/);

    // Three surfaces, one answer. The box is what the removal break leaves stale.
    await expect(pom.searchInput).toHaveValue("");
    await expect(pom.card(SEEDED)).toBeVisible();
  });

  test("typing keeps every character, trailing space included, while the buffer leads the URL", async ({
    page,
  }) => {
    const { pom } = await TournamentsListPage.navigateTo(page);

    // Character by character: each keystroke renders once with the new buffer text and
    // the OLD url, and a resync keyed on a bare mismatch resets the box right there.
    await pom.searchInput.pressSequentially("Bay Area");

    // The box first, so a break reads as the truncated search text. Then the URL,
    // read after it has caught up with the last keystroke, so a short read cannot
    // pass for a race the resync happened to win.
    await expect(pom.searchInput).toHaveValue("Bay Area");
    await expect(page).toHaveURL(/[?&]q=Bay(\+|%20)Area(&|$)/);
    await expect(pom.card(SEEDED)).toBeVisible();

    // ...and the trailing space of a two-word search in progress survives, too. The
    // URL schema trims it, so the URL's echo must not overwrite the buffer.
    await pom.searchInput.pressSequentially(" ");
    await expect(pom.searchInput).toHaveValue("Bay Area ");
  });

  test("a same-route navigation that drops status returns the tab to All", async ({
    page,
  }) => {
    // The seed is `published`, so the Live tab hides it — and All brings it back.
    const { pom } = await TournamentsListPage.navigateTo(page);
    await expect(pom.card(SEEDED)).toBeVisible();

    await pom.statusTab("Live").click();
    await expect(page).toHaveURL(/[?&]status=live(&|$)/);
    await expect(pom.statusTab("Live")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(pom.card(SEEDED)).toHaveCount(0);

    await pom.sidebarTournamentsLink.click();
    await expect(page).not.toHaveURL(/[?&]status=/);

    // Status is derived from the URL on every render — it has no buffer to go stale.
    await expect(pom.statusTab("All")).toHaveAttribute("aria-selected", "true");
    await expect(pom.statusTab("Live")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(pom.card(SEEDED)).toBeVisible();
  });
});
