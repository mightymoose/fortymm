import { test, expect } from '@playwright/test';
import { player } from '../../src/test/factories';
import { NewMatchPage } from '../page-objects/matches/new-match.page';

test.use({ viewport: { width: 375, height: 667 } });

/** A single unbreakable token wider than a 375px column — the #74 repro. */
const LONG_OPPONENT = player({
    username: 'maximiliana_von_habsburg_longnametest',
});

test.describe('Mobile New Match summary line (375px)', () => {
    test('long opponent name wraps instead of clipping mid-word', async ({
        page,
    }, testInfo) => {
        const nm = await NewMatchPage.open(page, { players: [LONG_OPPONENT] });
        await nm.pickPlayer(LONG_OPPONENT.username);

        await expect(nm.summaryTop).toBeVisible();
        await expect(nm.summaryTop).toContainText(LONG_OPPONENT.username);

        await page.screenshot({
            path: testInfo.outputPath('summary-long-name-mobile.png'),
            fullPage: true,
        });

        // The line must not overflow its column — i.e. it wrapped rather than
        // being clipped mid-word. Allow 1px for sub-pixel rounding.
        const overflow = await nm.summaryTop.evaluate(
            (el) => el.scrollWidth - el.clientWidth,
        );
        expect(overflow, 'summary top line overflows its column').toBeLessThanOrEqual(1);
    });
});
