import { test, expect } from '@playwright/test';
import { DashboardPage } from '../page-objects/dashboard.page';

test.describe('Dashboard match widgets', () => {
    test('renders the first-match layout for a fresh guest, not the loading skeletons', async ({ page }) => {
        await DashboardPage.navigateTo(page);

        // A brand-new guest has zero completed matches and nothing in play, so
        // the dashboard renders the first-match hero/rating/empty-matches
        // layout (see CONTEXT.md "First-match") instead of the normal
        // AttentionPanel/YourGameRow render path.
        await expect(
            page.getByRole('heading', { name: 'Log your first match.' }),
        ).toBeVisible();
        await expect(page.getByText('No matches yet. Go play.')).toBeVisible();

        await expect(page.getByRole('status', { name: 'Loading attention panel' })).toHaveCount(0);
        await expect(page.getByRole('status', { name: 'Loading recent matches' })).toHaveCount(0);
    });
});
