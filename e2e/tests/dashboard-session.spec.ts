import { test, expect } from '@playwright/test';
import { DashboardPage } from '../page-objects/dashboard.page';

test.describe('Dashboard', () => {
    test('issues a session to a first-time visitor', async ({ page, context }) => {
        const sessionResponse = page.waitForResponse((response) =>
            response.url().includes('/v1/session') && response.request().method() === 'GET',
        );
        await DashboardPage.navigateTo(page);
        await sessionResponse;

        const cookies = await context.cookies();
        const session = cookies.find((cookie) => cookie.name === 'session');
        expect(session, 'session cookie should be set').toBeDefined();
        expect(session?.value).not.toBe('');
        expect(session?.httpOnly).toBe(true);
    });
});
