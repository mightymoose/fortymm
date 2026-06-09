import { test, expect, Page } from '@playwright/test';
import { matchDetails, sessionResponse } from '../../src/test/factories';
import type { components } from '../../src/api/schema';

type MatchDetails = components['schemas']['MatchDetails'];

/** A decided singles match: rita.kovac beat silva.r, 3 games to 1. */
const decidedMatch = (id: string): MatchDetails =>
    matchDetails({
        id,
        status: 'completed',
        status_label: 'Final',
        sides: [
            {
                side_number: 1,
                players: [
                    { user_id: 'u-me', username: 'rita.kovac', is_current_user: true },
                ],
                games_won: 3,
                won: true,
                is_current_user_side: true,
            },
            {
                side_number: 2,
                players: [
                    { user_id: 'pl-silva', username: 'silva.r', is_current_user: false },
                ],
                games_won: 1,
                won: false,
                is_current_user_side: false,
            },
        ],
        games: [],
        current_game: null,
        can_score: false,
    });

class MatchDetailsPage {
    constructor(private readonly page: Page) {}

    /** The e2e suite runs with MSW disabled (see playwright.config.ts), so the
     * endpoints this page touches are mocked here via `page.route`. */
    async mock(match: MatchDetails) {
        await this.page.route('**/api/v1/session', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(
                    sessionResponse({ user: { username: 'rita.kovac' } }),
                ),
            }),
        );
        await this.page.route(`**/api/v1/matches/${match.id}`, (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(match),
            }),
        );
    }

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
            await matchDetailsPage.mock(decidedMatch('m-completed-win-1'));
            await matchDetailsPage.goTo('m-completed-win-1');
            await expect(page.getByRole('region', { name: 'rita.kovac defeated silva.r, 3 games to 1' })).toBeVisible();
        });
    });
});
