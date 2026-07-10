import { test, expect } from '@playwright/test';
import { DesignSystemPage } from './page-objects/design-system.page';
import type { Rect } from './page-objects/design-system-page/tooltip-showcase.page';

/** Two rects intersect when they overlap on both axes (touching edges don't
 *  count as overlap). */
function rectsIntersect(a: Rect, b: Rect): boolean {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

test.describe('Design System', () => {
  test('should style the buttons correctly', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    await expect(designSystemPage.buttonShowcase.primaryButton).toHaveScreenshot('plain-button.png');
    await expect(designSystemPage.buttonShowcase.secondaryButton).toHaveScreenshot('secondary-button.png');
    await expect(designSystemPage.buttonShowcase.outlineButton).toHaveScreenshot('outline-button.png');
    await expect(designSystemPage.buttonShowcase.ghostButton).toHaveScreenshot('ghost-button.png');
    await expect(designSystemPage.buttonShowcase.destructiveButton).toHaveScreenshot('destructive-button.png');
    await expect(designSystemPage.buttonShowcase.linkButton).toHaveScreenshot('link-button.png');
    await expect(designSystemPage.buttonShowcase.disabledButton).toHaveScreenshot('disabled-button.png');
    await expect(designSystemPage.buttonShowcase.smallButton).toHaveScreenshot('small-button.png');
    await expect(designSystemPage.buttonShowcase.defaultButton).toHaveScreenshot('default-button.png');
    await expect(designSystemPage.buttonShowcase.largeButton).toHaveScreenshot('large-button.png');
    await expect(designSystemPage.buttonShowcase.iconButton).toHaveScreenshot('icon-button.png');
  });

  test('should style the inputs correctly', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    await expect(designSystemPage.inputShowcase.playerTagInput).toHaveScreenshot('player-tag-input.png');
    await expect(designSystemPage.inputShowcase.emailInput).toHaveScreenshot('email-input.png');
    await expect(designSystemPage.inputShowcase.disabledInput).toHaveScreenshot('disabled-input.png');
    await expect(designSystemPage.inputShowcase.searchInput).toHaveScreenshot('search-input.png');
  });

  // The Dialog/AlertDialog/Sheet showcases render static always-open facsimiles
  // (the real portaled components can't show their open state inside a demo
  // card). They're hand-authored static markup, so we assert their structure —
  // heading + actions — rather than pixel-snapshotting our own markup against
  // fragile per-platform baselines.
  test('renders the dialog facsimile with its actions', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    const dialog = await designSystemPage.overlayShowcase.dialogPanel();
    await Promise.all([
      expect(dialog.getByRole('button', { name: 'Forfeit' })).toBeVisible(),
      expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible(),
    ]);
  });

  test('renders the alert dialog facsimile with its actions', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    const alertDialog = await designSystemPage.overlayShowcase.alertDialogPanel();
    await Promise.all([
      expect(alertDialog.getByRole('button', { name: 'Delete' })).toBeVisible(),
      expect(
        alertDialog.getByRole('button', { name: 'Keep account' }),
      ).toBeVisible(),
    ]);
  });

  test('renders the sheet facsimile with its filter controls', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    const sheet = await designSystemPage.sheetShowcase.sheetPanel();
    await expect(
      sheet.getByRole('button', { name: 'Apply filters' }),
    ).toBeVisible();
  });

  test('should style the toasts correctly', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    await expect(designSystemPage.feedbackShowcase.successToast).toHaveScreenshot('toast-success.png');
    await expect(designSystemPage.feedbackShowcase.errorToast).toHaveScreenshot('toast-error.png');
    await expect(designSystemPage.feedbackShowcase.infoToast).toHaveScreenshot('toast-info.png');
  });

  // #268 / #831: both the counter and the highlighted slide are derived from
  // embla's real API. The invariant we encode is: counter numerator === the
  // highlighted slide's number, checked after every navigation, and the
  // numerator is never stranded below the denominator.
  test('carousel counter and highlight track embla, and reach the last snap', async ({
    page,
  }) => {
    const { carouselShowcase } = await DesignSystemPage.navigateTo(page);

    const assertInvariant = async (expectedCounter: string) => {
      await expect(carouselShowcase.counter()).toHaveText(expectedCounter);
      // The highlighted slide (border-2) must match the counter numerator.
      await expect
        .poll(async () => carouselShowcase.highlightedSlideNumber())
        .toBe(await carouselShowcase.counterNumerator());
    };

    // Starts on the first of five reachable snaps.
    await assertInvariant('01 / 05');

    await carouselShowcase.next.click();
    await assertInvariant('02 / 05');

    await carouselShowcase.next.click();
    await assertInvariant('03 / 05');

    // Step deterministically to the last snap (5 total).
    await carouselShowcase.next.click();
    await assertInvariant('04 / 05');
    await carouselShowcase.next.click();
    await assertInvariant('05 / 05');

    // At the last snap Next is disabled and the numerator has reached the
    // denominator — never stranded below it.
    await expect(carouselShowcase.next).toBeDisabled();

    // Previous walks back.
    await carouselShowcase.previous.click();
    await assertInvariant('04 / 05');
  });

  // #261: the weekday header must read single-letter abbreviations, not
  // date-fns' default three-letter `EEE`.
  test('date picker weekday header reads single letters', async ({ page }) => {
    const { datePickerShowcase } = await DesignSystemPage.navigateTo(page);

    expect(await datePickerShowcase.weekdayHeaders()).toEqual([
      'S',
      'M',
      'T',
      'W',
      'T',
      'F',
      'S',
    ]);
  });

  // #273: the "Show all" collapsible trigger uses a plain ↓ glyph, not a lucide
  // ChevronDown <svg>.
  test('collapsible trigger uses a glyph, not an svg icon', async ({ page }) => {
    const { collapsibleShowcase } = await DesignSystemPage.navigateTo(page);

    expect(await collapsibleShowcase.triggerText()).toContain('↓');
    expect(await collapsibleShowcase.triggerSvgCount()).toBe(0);
  });

  // #832: the two always-open tooltip bubbles must never overlap — at the
  // default viewport and at mobile width.
  test('tooltip bubbles never overlap', async ({ page }) => {
    const { tooltipShowcase } = await DesignSystemPage.navigateTo(page);

    const assertNoOverlap = async () => {
      let rects: Rect[] = [];
      // floating-ui positions asynchronously; let the geometry settle.
      await expect
        .poll(async () => {
          rects = await tooltipShowcase.bubbleRects();
          return rects.length;
        })
        .toBe(2);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(
            rectsIntersect(rects[i]!, rects[j]!),
            `tooltip bubbles ${i} and ${j} overlap: ${JSON.stringify(rects)}`,
          ).toBe(false);
        }
      }
    };

    await assertNoOverlap();

    await page.setViewportSize({ width: 375, height: 667 });
    await assertNoOverlap();
  });

  // #833: no horizontal overflow at mobile width.
  test.describe('at mobile width', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test('the page does not overflow horizontally', async ({ page }) => {
      const designSystemPage = await DesignSystemPage.navigateTo(page);
      // Measure only once the page has fully rendered — the carousel is the
      // last section, so its presence means every showcase above is laid out.
      // Reading `evaluate` metrics before render would false-pass on real
      // overflow (the DOM is still near-empty).
      await page.locator('[data-slot="carousel"]').waitFor();

      const { scrollWidth, clientWidth } = await designSystemPage.documentWidths();
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      // Stronger invariant: nothing wide spills past the viewport's right edge
      // without an overflow-clipping ancestor. (The carousel strip and Table
      // legitimately spill but are clipped by an ancestor.)
      const overflowing = await designSystemPage.unclippedOverflowingElements();
      expect(
        overflowing,
        `unclipped elements past the right edge: ${JSON.stringify(overflowing, null, 2)}`,
      ).toEqual([]);
    });
  });
});
