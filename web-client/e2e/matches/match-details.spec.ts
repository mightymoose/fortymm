import { test, expect, Page } from '@playwright/test';


class MatchDetailsPage {
    constructor(private readonly page: Page) {}

    goTo(matchId: string) {
        return this.page.goto(`/matches/${matchId}`);
    }
}

test.describe('Match Details', () => {
    let matchDetailsPage: MatchDetailsPage;

    test.beforeEach(async ({ page }) => {
        matchDetailsPage = new MatchDetailsPage(page);
    });

    test.describe('the scoreboard', () => {
        test('names the hero region with the decided-match outcome', async ({ page }) => {
            await matchDetailsPage.goTo('m-completed-win-1');
            await expect(page.getByRole('region', { name: 'rita.kovac defeated silva.r, 3 games to 1' })).toBeVisible();
        });
    });
});
