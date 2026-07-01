import { expect, test, type Page, type Route } from '@playwright/test';
import {
    matchListResponse,
    matchListRow,
    sessionResponse,
} from '../../src/test/factories';

const SESSION = sessionResponse({ user: { username: 'rita.kovac' } });

/** Enough cards that the list is taller than a 375×667 phone viewport. */
const ROWS = Array.from({ length: 8 }, (_, i) =>
    matchListRow({
        id: `m-${i}`,
        opponent: `opponent.${i}`,
        status: 'in_progress',
        status_label: 'Live',
        current_game_number: 2,
    }),
);

async function installListMock(page: Page) {
    await page.route('**/api/v1/**', (route: Route) => {
        const path = new URL(route.request().url()).pathname.replace(
            /^\/api/,
            '',
        );
        if (path === '/v1/session') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(SESSION),
            });
        }
        if (path === '/v1/matches' && route.request().method() === 'GET') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(
                    matchListResponse({ items: ROWS, total: ROWS.length }),
                ),
            });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
}

test.use({ viewport: { width: 375, height: 667 } });

test.describe('Mobile /matches scroll (#702)', () => {
    test('the whole page scrolls; the card list is not trapped in a short inner window', async ({
        page,
    }, testInfo) => {
        await installListMock(page);
        await page.goto('/matches');

        // Cards rendered.
        const rows = page.locator('table.matches tbody tr');
        await expect(rows.first()).toBeVisible();
        expect(await rows.count()).toBe(ROWS.length);

        await page.screenshot({
            path: testInfo.outputPath('matches-mobile.png'),
            fullPage: true,
        });

        // The `.table-wrap` must NOT be the scroll container: with page-scroll
        // it grows to its content instead of clipping the list into a ~283px
        // window. Allow 1px for rounding.
        const wrap = page.locator('.table-wrap');
        const wrapClipped = await wrap.evaluate(
            (el) => el.scrollHeight - el.clientHeight,
        );
        expect(
            wrapClipped,
            '.table-wrap still clips the card list into an inner scroll window',
        ).toBeLessThanOrEqual(1);

        // The document itself scrolls (the list is taller than the viewport).
        const docScrollable = await page.evaluate(
            () =>
                document.documentElement.scrollHeight > window.innerHeight + 1,
        );
        expect(docScrollable, 'the page as a whole does not scroll').toBe(true);

        // The sticky topbar stays pinned after scrolling to the bottom.
        await page.evaluate(() =>
            window.scrollTo(0, document.documentElement.scrollHeight),
        );
        const topbar = page.locator('.app-shell__topbar');
        const box = await topbar.boundingBox();
        expect(box, 'topbar has no box').not.toBeNull();
        expect(
            Math.abs(box!.y),
            'topbar did not stay pinned to the viewport top',
        ).toBeLessThanOrEqual(2);
    });
});
