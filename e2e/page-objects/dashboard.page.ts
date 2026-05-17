import { Page } from "@playwright/test";

export class DashboardPage {
    static async navigateTo(page: Page): Promise<DashboardPage> {
        await page.goto('/dashboard');
        return new DashboardPage();
    }
}
