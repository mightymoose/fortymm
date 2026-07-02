import { test, expect } from '@playwright/test';
import { DashboardPage } from '../page-objects/dashboard.page';

test.describe('Dashboard', () => {
    test('issues a session to a first-time visitor', async ({ page, context }) => {
        const dashboard = await DashboardPage.navigateTo(page);

        await expect(dashboard.userMenu.skeleton).not.toBeVisible();
        await expect(dashboard.userMenu.menu).not.toContainText('Guest');

        const cookies = await context.cookies();
        const session = cookies.find((cookie) => cookie.name === 'session');
        expect(session, 'session cookie should be set').toBeDefined();
        expect(session?.value).not.toBe('');
        expect(session?.httpOnly).toBe(true);
    });

    test('opening several cold tabs at once mints only one guest session', async ({ context }) => {
        // Regression for #824: each tab has its own QueryClient, so without an
        // origin-wide singleflight every one of these would race
        // `/v1/session` and mint its own guest, with the last `Set-Cookie`
        // winning and the others left holding a stale identity.
        const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
        const dashboards = await Promise.all(pages.map((page) => DashboardPage.navigateTo(page)));

        for (const dashboard of dashboards) {
            await expect(dashboard.userMenu.skeleton).not.toBeVisible();
            await expect(dashboard.userMenu.menu).not.toContainText('Guest');
        }

        const usernames = await Promise.all(dashboards.map((dashboard) => dashboard.userMenu.menu.innerText()));
        expect(new Set(usernames).size).toBe(1);

        const cookies = await context.cookies();
        const sessionCookies = cookies.filter((cookie) => cookie.name === 'session');
        expect(sessionCookies).toHaveLength(1);
        expect(sessionCookies[0]?.value).not.toBe('');

        await Promise.all(pages.map((page) => page.close()));
    });
});
