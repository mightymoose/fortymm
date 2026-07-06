import { test, expect, Page, Locator } from '@playwright/test';
import { matchDetails, sessionResponse } from '../../src/test/factories';
import type { components } from '../../src/api/schema';

type MatchDetails = components['schemas']['MatchDetails'];
type MatchNegotiation = components['schemas']['MatchNegotiation'];

const CORRECTED_ID = '00000000-0000-4000-8000-0000000007a0';
const REVIEW_ID = '00000000-0000-4000-8000-0000000007b0';

const ISO = '2026-01-01T00:00:00Z';

const negGame = (n: number, s1: number, s2: number) => ({
    game_number: n,
    side_1_points: s1,
    side_2_points: s2,
});

/** Rated match whose opponent countered the viewer's proposal: the `corrected`
 * callout renders the ScoreDiff (a changed game + a NEW GAME row) above the
 * stakes line — the exact #740 repro. */
const correctedNegotiation = (): MatchNegotiation => ({
    viewer_state: 'corrected',
    your_turn: true,
    standing_result: {
        id: '00000000-0000-4000-8000-0000000007a1',
        games: [negGame(1, 9, 11), negGame(2, 11, 5), negGame(3, 11, 8)],
        submitted_by: '00000000-0000-4000-8000-0000000007a2',
        submitted_at: ISO,
    },
    prior_result: {
        id: '00000000-0000-4000-8000-0000000007a3',
        games: [negGame(1, 11, 7), negGame(2, 11, 5)],
        submitted_by: '00000000-0000-4000-8000-0000000007a4',
        submitted_at: ISO,
    },
    diff: [
        { game_number: 1, old: negGame(1, 11, 7), new: negGame(1, 9, 11) },
        { game_number: 3, old: null, new: negGame(3, 11, 8) },
    ],
});

const reviewNegotiation = (): MatchNegotiation => ({
    viewer_state: 'review',
    your_turn: true,
    standing_result: {
        id: '00000000-0000-4000-8000-0000000007b1',
        games: [negGame(1, 11, 7), negGame(2, 11, 5), negGame(3, 11, 8)],
        submitted_by: '00000000-0000-4000-8000-0000000007b2',
        submitted_at: ISO,
    },
    prior_result: null,
    diff: null,
});

const negotiatingMatch = (
    id: string,
    negotiation: MatchNegotiation,
): MatchDetails =>
    matchDetails({
        id,
        status: 'in_progress',
        status_label: 'Live',
        affects_rating: true,
        can_score: false,
        current_game: null,
        negotiation,
    });

class Harness {
    constructor(private readonly page: Page) {}

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

    goTo(id: string) {
        return this.page.goto(`/matches/${id}`);
    }
}

type Box = { x: number; y: number; width: number; height: number };

const boxOf = async (loc: Locator): Promise<Box> => {
    const box = await loc.boundingBox();
    if (!box) throw new Error('element not visible / no box');
    return box;
};

/** Vertical overlap in px between two boxes (>0 means they collide). */
const vOverlap = (a: Box, b: Box): number =>
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);

/** Relative luminance (0=black, 1=white) of an element's computed text color.
 * Guards #740/#731: the stakes helper text used `--muted` (a dark *surface*
 * token, ~0.02 luminance) and read as "hidden behind" the box — legible muted
 * text (`--muted-foreground`, a light chalk grey) sits well above 0.3. */
const textLuminance = (loc: Locator): Promise<number> =>
    loc.evaluate((el) => {
        const m = getComputedStyle(el)
            .color.match(/[\d.]+/g)!
            .map(Number);
        const [r, g, b] = m.map((c) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    });

test.use({ viewport: { width: 375, height: 667 } });

test.describe('Mobile acceptance callout layout (375px)', () => {
    test('corrected: diff box, stakes line, and actions do not overlap', async ({
        page,
    }, testInfo) => {
        const h = new Harness(page);
        await h.mock(negotiatingMatch(CORRECTED_ID, correctedNegotiation()));
        await h.goTo(CORRECTED_ID);

        const callout = page.getByTestId('match-confirm-callout');
        await expect(callout).toBeVisible();

        const diff = page.getByTestId('score-diff');
        const stakes = callout.locator('.md-confirm-callout__stakes');
        const accept = callout.getByRole('button', { name: /Accept/ });
        const counter = callout.getByRole('link', { name: /Counter/ });

        await expect(diff).toBeVisible();
        await expect(stakes).toBeVisible();

        await page.screenshot({
            path: testInfo.outputPath('corrected-mobile.png'),
            fullPage: true,
        });

        const [diffBox, stakesBox, acceptBox, counterBox] = await Promise.all([
            boxOf(diff),
            boxOf(stakes),
            boxOf(accept),
            boxOf(counter),
        ]);

        // #740: the diff box must sit fully above the stakes paragraph.
        expect(
            vOverlap(diffBox, stakesBox),
            'score-diff overlaps the stakes line',
        ).toBeLessThanOrEqual(0);
        // #731: the stakes helper text must clear the Accept/Counter row.
        expect(
            vOverlap(stakesBox, acceptBox),
            'stakes line overlaps the Accept button',
        ).toBeLessThanOrEqual(0);
        expect(
            vOverlap(stakesBox, counterBox),
            'stakes line overlaps the Counter link',
        ).toBeLessThanOrEqual(0);
        // #740/#731: the helper text must be legible, not near-invisible.
        expect(
            await textLuminance(stakes),
            'stakes helper text is too low-contrast to read',
        ).toBeGreaterThan(0.3);
    });

    test('review: stakes line does not overlap the actions row', async ({
        page,
    }, testInfo) => {
        const h = new Harness(page);
        await h.mock(negotiatingMatch(REVIEW_ID, reviewNegotiation()));
        await h.goTo(REVIEW_ID);

        const callout = page.getByTestId('match-confirm-callout');
        await expect(callout).toBeVisible();

        const stakes = callout.locator('.md-confirm-callout__stakes');
        const accept = callout.getByRole('button', { name: /Accept/ });
        const correct = callout.getByRole('link', { name: /Suggest correction/ });

        await expect(stakes).toBeVisible();
        await page.screenshot({
            path: testInfo.outputPath('review-mobile.png'),
            fullPage: true,
        });

        const [stakesBox, acceptBox, correctBox] = await Promise.all([
            boxOf(stakes),
            boxOf(accept),
            boxOf(correct),
        ]);

        expect(
            vOverlap(stakesBox, acceptBox),
            'stakes line overlaps the Accept button',
        ).toBeLessThanOrEqual(0);
        expect(
            vOverlap(stakesBox, correctBox),
            'stakes line overlaps the Suggest correction link',
        ).toBeLessThanOrEqual(0);
        expect(
            await textLuminance(stakes),
            'stakes helper text is too low-contrast to read',
        ).toBeGreaterThan(0.3);
    });
});
