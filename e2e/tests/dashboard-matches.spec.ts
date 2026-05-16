import { test, expect } from '@playwright/test';
import { DashboardPage } from '../page-objects/dashboard.page';

test.describe('Dashboard match widgets', () => {
    test('renders non-skeleton match widgets after the dashboard query resolves', async ({ page }) => {
        await DashboardPage.navigateTo(page);

        await expect(page.getByText('No upcoming match yet.')).toBeVisible();
        await expect(page.getByText('No completed matches yet.')).toBeVisible();

        await expect(page.getByRole('status', { name: 'Loading score banner' })).toHaveCount(0);
        await expect(page.getByRole('status', { name: 'Loading next match' })).toHaveCount(0);
        await expect(page.getByRole('status', { name: 'Loading recent matches' })).toHaveCount(0);
    });
});
