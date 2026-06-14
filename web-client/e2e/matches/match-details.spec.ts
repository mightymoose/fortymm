import { test, expect, Page } from '@playwright/test';
import { matchDetails, sessionResponse } from '../../src/test/factories';
import type { components } from '../../src/api/schema';

type MatchDetails = components['schemas']['MatchDetails'];

const gameScore = (
    gameNumber: number,
    side1Points: number,
    side2Points: number,
): MatchDetails['games'][number] => ({
    id: `g-${gameNumber}`,
    game_number: gameNumber,
    score: {
        id: `s-${gameNumber}`,
        side_1_points: side1Points,
        side_2_points: side2Points,
        winner_side_number: side1Points > side2Points ? 1 : 2,
    },
});

// The match-details route guards its `$matchId` param to the UUID shape (real
// match ids are UUIDs; a non-UUID is a malformed URL the route short-circuits
// to the not-found state without fetching). So fixtures driven through the
// route must use a UUID-shaped id, not a readable `m-...` slug.
const COMPLETED_WIN_ID = '00000000-0000-4000-8000-000000000001';

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
        games: [
            gameScore(1, 11, 7),
            gameScore(2, 9, 11),
            gameScore(3, 11, 5),
            gameScore(4, 11, 8),
        ],
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
            await matchDetailsPage.mock(decidedMatch(COMPLETED_WIN_ID));
            await matchDetailsPage.goTo(COMPLETED_WIN_ID);
            await expect(page.getByRole('region', { name: 'rita.kovac defeated silva.r, 3 games to 1' })).toBeVisible();
        });

        // Regression test for #472: the current user's row renders its cells
        // as edit links (<a>), and the `.match-details a { color: inherit }`
        // reset used to out-rank the win/loss colors, leaving the row colorless.
        test('colors the editable (current-user) row win/loss cells like the opponent row', async ({ page }) => {
            await matchDetailsPage.mock(decidedMatch(COMPLETED_WIN_ID));
            await matchDetailsPage.goTo(COMPLETED_WIN_ID);

            const color = (testId: string) =>
                page
                    .getByTestId(testId)
                    .evaluate((el) => getComputedStyle(el).color);

            const winColor = 'rgb(0, 226, 154)'; // --serve-500

            // Current-user row, game 1 (won, rendered as an edit link).
            const myWinCell = page.getByTestId('scoreboard-game-grid-cell-left-1');
            await expect(myWinCell).toHaveText('11');
            await expect(
                myWinCell.locator('xpath=self::a'),
                'editable cell renders as a link',
            ).toBeVisible();
            expect(await color('scoreboard-game-grid-cell-left-1')).toBe(winColor);

            // Won and lost cells on the editable row must be distinguishable.
            const myLossColor = await color('scoreboard-game-grid-cell-left-2');
            expect(myLossColor).not.toBe(winColor);

            // And the editable row must match the opponent (non-link) row.
            expect(await color('scoreboard-game-grid-cell-right-2')).toBe(winColor);
            expect(await color('scoreboard-game-grid-cell-right-1')).toBe(myLossColor);
        });
    });
});
