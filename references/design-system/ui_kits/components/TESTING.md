# Screenshot testing (Playwright)

Every page that loads `kit.js` (gallery, state matrix, previews, tournament screens, before/after) supports a test mode.

## URL flags
- `?test` — no transitions or animation, no text caret, hidden scrollbars in `.fm-scroll`, tooltips appear instantly, toasts stay until dismissed. (Or set `<html data-test>`.)
- `?test&only=<testid>` — renders just that example, flush top-left with 24px padding. Dialogs, tooltips and toasts still render.

## Ready signal
`<html data-fm-ready="true">` is set after fonts have loaded, every component is initialised and two frames have painted. `window.FM.test.ready` is the same thing as a promise.

## Deterministic content
- No `Math.random` or wall-clock time. Dates come from each date picker's `today` config (10 April 2026); the schedule's "now" is fixed at 11:47.
- Generated ids are sequential.
- Native `<select>`, `<input type=range>` and the focus ring on native checkboxes render per-OS — keep baselines per platform (Playwright does this by default).

## Helpers (`page.evaluate`)
All return a promise that resolves after the state is painted.
- `FM.test.tooltip(selector)` / `FM.test.hideTooltip()`
- `FM.test.openCalendar('[data-testid=datepicker-field]')`
- `FM.test.openCombo('[data-testid=combobox-opponent]', 'ngu')`
- `FM.test.toast('Result saved', { undo: () => {} })`
- `FM.test.dialog('dlg')` — also `sheet-match`, `sheet-move` (prefer clicking `sheet-move-trigger`, which fills the options)
- `FM.test.palette('patel')` — opens the command palette with a query
- `FM.test.clear()` — closes every tooltip, toast, dialog, calendar and list

## Example
```ts
import { test, expect, Page } from '@playwright/test';

const open = async (page: Page, path: string, only?: string) => {
  await page.goto(`${path}?test${only ? `&only=${only}` : ''}`);
  await page.locator('html[data-fm-ready="true"]').waitFor();
};

test('buttons', async ({ page }) => {
  await open(page, '/ui_kits/components/index.html');
  await expect(page.getByTestId('ex-variants')).toHaveScreenshot('buttons-variants.png');
});

test('state matrix: focused invalid field', async ({ page }) => {
  await open(page, '/ui_kits/components/states.html');
  await expect(page.getByTestId('state-text-field--error-focus')).toHaveScreenshot();
});

test('combobox open', async ({ page }) => {
  await open(page, '/ui_kits/components/index.html', 'ex-combobox');
  await page.evaluate(() => FM.test.openCombo('[data-testid=combobox-opponent]', 'ngu'));
  await expect(page).toHaveScreenshot('combobox-ngu.png');
});

test('date picker via keyboard', async ({ page }) => {
  await open(page, '/ui_kits/components/index.html', 'ex-date-picker');
  await page.getByRole('button', { name: 'Open calendar' }).press('Enter');
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveScreenshot('datepicker-open.png');
});
```
For overlays (tooltip, calendar, combobox list, toast, dialog) screenshot the page or a clip, not the example locator — overlays extend beyond it.

## Test ids
**Gallery** (`index.html`)
- Sections: `section-roles`, `section-actions`, `section-forms`, `section-selection`, `section-containers`, `section-feedback`, `section-overlays`, `section-match`, `section-more`
- Examples: `ex-variants`, `ex-loading-and-disabled`, `ex-text-field`, `ex-code-input`, `ex-combobox`, `ex-date-picker`, `ex-checkbox-radio-and-switch`, `ex-card`, `ex-scroll-area`, `ex-split-view`, `ex-toast`, `ex-inline-notice`, `ex-warning-and-error`, `ex-status-set`, `ex-tooltip`, `ex-dialog`, `ex-menu`, `ex-sheet-and-drawer`, `ex-command-palette`, `ex-match-row`, `ex-empty-and-disconnected`, `ex-score-entry-and-game-history`, `ex-schedule-blocks`, `ex-rest-indicator`, `ex-data-table`, `ex-tags-avatar-progress`, `ex-navigation`, `ex-menubar`, `ex-carousel`, `ex-accordion`
- Roles overview: `role-card`, `role-notice-examples`, `role-toast`, `role-tooltip`, `role-warning`, `role-error`
- Controls: `combobox-opponent`, `datepicker-field`, `datepicker-inline`, `tooltip-trigger`, `dialog-trigger`, `dialog-withdraw`, `code-input`, `sheet-match-trigger`, `sheet-match`, `sheet-move-trigger`, `sheet-move`, `palette-trigger`, `command-palette`

**State matrix** (`states.html`): `state-matrix`; one row per component, `state-<component>`; one cell per applicable state, `state-<component>--<state>`.
- Components: `primary-button`, `secondary-button`, `ghost-button`, `danger-button`, `text-field`, `select`, `checkbox`, `radio`, `switch`, `filter-chip`, `segmented-option`, `tab`, `schedule-block`
- States: `default`, `hover`, `focus`, `pressed`, `selected`, `disabled`, `loading`, `error`, `error-focus`. Not-applicable cells have no id.

**Before and after** (`Components before and after.html`): `ba-<name>`, `ba-<name>--before`, `ba-<name>--after` for `tooltip`, `toast`, `card`, `fields`, `buttons`, `match-row`.
