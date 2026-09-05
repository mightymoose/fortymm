import { stubUnreadNotifications } from '../support/notifications'
import { test, expect, Page } from '@playwright/test';
import { matchDetails, sessionResponse } from '../../src/test/factories';
import type { components } from '../../src/api/schema';
import { stubRealtimeStream } from '../support/realtime';

// The generated schema namespaces this one (two pydantic models share the name),
// so `components['schemas']['MatchDetails']` does not exist — it silently
// resolved to an error type, and since nothing type-checks `e2e/` (tsc -b covers
// `src` only), these stubs were never actually held to the wire shape. Named
// properly, `rating_change` below is checked against the real `RatingChange`.
type MatchDetails =
    components['schemas']['app__schemas__match__MatchDetails'];

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
        // A freshly created score starts at version 1 (the create body carries
        // no version; `expected_version = 0` means "no score exists yet").
        version: 1,
    },
});

// The match-details route guards its `$matchId` param to the UUID shape (real
// match ids are UUIDs; a non-UUID is a malformed URL the route short-circuits
// to the not-found state without fetching). So fixtures driven through the
// route must use a UUID-shaped id, not a readable `m-...` slug.
const COMPLETED_WIN_ID = '00000000-0000-4000-8000-000000000001';
const SCORABLE_ID = '00000000-0000-4000-8000-000000000002';

/**
 * A live, still-scorable singles match where the current user (side 1) has a
 * won game (1, 11–7) and a lost game (2, 9–11). Because `can_score` is true,
 * the current user's scored cells render as edit links (`<a>`) — the case the
 * #472 color reset regresses on.
 */
const scorableMatch = (id: string): MatchDetails =>
    matchDetails({
        id,
        status: 'in_progress',
        status_label: 'Live',
        sides: [
            {
                side_number: 1,
                players: [
                    { user_id: 'u-me', username: 'rita.kovac', is_current_user: true },
                ],
                games_won: 1,
                won: null,
                is_current_user_side: true,
            },
            {
                side_number: 2,
                players: [
                    { user_id: 'pl-silva', username: 'silva.r', is_current_user: false },
                ],
                games_won: 1,
                won: null,
                is_current_user_side: false,
            },
        ],
        games: [gameScore(1, 11, 7), gameScore(2, 9, 11)],
        current_game: { game_number: 3 },
        can_score: true,
    });

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

/**
 * A decided, **rated** match — and the two kinds of rating change in one payload:
 *
 * - side 1 (rita.kovac, the viewer) was already rated and **MOVED**: 1612 → 1624,
 *   `+12`;
 * - side 2 (invisible-sloth) was **ESTABLISHED** by this match: `before` and
 *   `delta` are both null, and they came out at 1268. The card must read
 *   `Unrated → 1268` with no delta — never `1500 → 1268 (−232)` (#952).
 *
 * The stub is written out longhand rather than through the vitest factories on
 * purpose: this suite runs with **MSW off**, so these `page.route` bodies are the
 * only contract the browser ever sees, and a schema drift here is invisible to
 * vitest (web-client/CLAUDE.md).
 */
const establishedRatingMatch = (id: string): MatchDetails => ({
    ...decidedMatch(id),
    affects_rating: true,
    sides: [
        {
            side_number: 1,
            players: [
                { user_id: 'u-me', username: 'rita.kovac', is_current_user: true },
            ],
            games_won: 3,
            won: true,
            is_current_user_side: true,
            rating_change: { before: 1612, after: 1624, delta: 12 },
        },
        {
            side_number: 2,
            players: [
                {
                    user_id: 'pl-sloth',
                    username: 'invisible-sloth',
                    is_current_user: false,
                },
            ],
            games_won: 1,
            won: false,
            is_current_user_side: false,
            // The null that means "established, not moved". `before` is null for
            // the same reason: there was no rating to move from.
            rating_change: { before: null, after: 1268, delta: null },
        },
    ],
    recent_form: [],
});

class MatchDetailsPage {
    constructor(private readonly page: Page) {}

    /** The e2e suite runs with MSW disabled (see playwright.config.ts), so the
     * endpoints this page touches are mocked here via `page.route`. */
    async mock(match: MatchDetails) {
        await stubRealtimeStream(this.page);
        await stubUnreadNotifications(this.page);
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
            await expect(page.getByRole('region', { name: 'rita.kovac defeated silva.r by 3 games to 1' })).toBeVisible();
        });

        // Regression test for #472: the current user's row renders its cells
        // as edit links (<a>), and the `.match-details a { color: inherit }`
        // reset used to out-rank the win/loss colors, leaving the row colorless.
        test('colors the editable (current-user) row win/loss cells like the opponent row', async ({ page }) => {
            await matchDetailsPage.mock(scorableMatch(SCORABLE_ID));
            await matchDetailsPage.goTo(SCORABLE_ID);

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

    // #888: the page rendered its own `<main className="md-page">` inside the
    // app shell's `<main className="app-shell__content">`, so a screen reader's
    // landmark list held two "main" regions, one nested in the other. The issue
    // was filed as a mobile bug; it was not — the wrapper was unconditional, and
    // the page reproduced it identically at 1280x800. Both viewports are pinned
    // below so a re-introduced responsive wrapper can't sneak it back in on one
    // of them. (The shared axe helper deliberately drops the `best-practice`
    // tag, which is where `landmark-one-main` lives — hence this targeted
    // assertion rather than a broader scan.)
    test.describe('landmarks', () => {
        const VIEWPORTS = [
            { name: 'desktop', size: { width: 1280, height: 800 } },
            { name: 'mobile', size: { width: 375, height: 667 } },
        ] as const;

        for (const { name, size } of VIEWPORTS) {
            test.describe(name, () => {
                test.use({ viewport: size });

                test(`exposes exactly one main landmark at ${name} (${size.width}x${size.height})`, async ({
                    page,
                }) => {
                    await matchDetailsPage.mock(decidedMatch(COMPLETED_WIN_ID));
                    await matchDetailsPage.goTo(COMPLETED_WIN_ID);

                    // Guard: the match content is on screen, so the counts below
                    // are of the finished page and not of an empty shell.
                    await expect(
                        page.getByRole('region', {
                            name: 'rita.kovac defeated silva.r by 3 games to 1',
                        }),
                    ).toBeVisible();

                    // What assistive tech actually enumerates: main landmarks,
                    // whether claimed by the <main> tag or by role="main".
                    await expect(page.getByRole('main')).toHaveCount(1);
                    // And that one is not wrapping another.
                    await expect(page.locator('main main')).toHaveCount(0);
                });
            });
        }
    });

    // #952: the card told a player "Unrated" in one panel and "1500 → 1268
    // (−232)" in another, inches apart. A first rated match does not *lose* you
    // 232 points — it *establishes* you at 1268. Proven here, in a real browser,
    // because this suite is the one that runs MSW-off against the real wire shape.
    test.describe('the Result · rating change card', () => {
        const ratingRow = (page: Page, username: string) =>
            page
                .locator('.md-rating-row')
                .filter({ has: page.locator('.md-rating-row__name', { hasText: username }) });

        test('reads a first rated match as "Unrated → 1268", with no delta', async ({ page }) => {
            await matchDetailsPage.mock(establishedRatingMatch(COMPLETED_WIN_ID));
            await matchDetailsPage.goTo(COMPLETED_WIN_ID);

            const row = ratingRow(page, 'invisible-sloth');
            const numbers = row.locator('.md-rating-row__numbers');
            await expect(numbers).toBeVisible();

            // The word, then the new rating. Not the seeded 1500 they never held.
            await expect(numbers).toHaveText('Unrated1268');
            await expect(numbers).not.toContainText('1500');

            // No chip at all: they did not gain, did not lose — they got rated.
            await expect(row.locator('.md-rating-row__delta-num')).toHaveCount(0);
            await expect(row).not.toContainText('−232');
            await expect(row).not.toContainText('-232');
            await expect(row).not.toContainText('+0');

            // And it is *named* honestly for a screen reader, since the chevron is
            // decorative — the old chip would have announced "Lost 232 rating".
            await expect(numbers).toHaveAttribute(
                'aria-label',
                'Unrated before this match, now rated 1268',
            );
        });

        test('still shows an already-rated player their signed delta', async ({ page }) => {
            // The other half of the guard: the fix must not silence a real move.
            await matchDetailsPage.mock(establishedRatingMatch(COMPLETED_WIN_ID));
            await matchDetailsPage.goTo(COMPLETED_WIN_ID);

            const row = ratingRow(page, 'rita.kovac');
            await expect(row.locator('.md-rating-row__numbers')).toHaveText('16121624');

            const delta = row.locator('.md-rating-row__delta-num');
            await expect(delta).toHaveText('+12');
            await expect(delta).toHaveAttribute('aria-label', 'Gained 12 rating');
        });
    });
});
