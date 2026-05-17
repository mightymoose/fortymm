import { Page } from "@playwright/test";
import { UserMenuPage } from "./dashboard-page/user-menu.page";

export class DashboardPage {
    public readonly userMenu: UserMenuPage;

    static async navigateTo(page: Page): Promise<DashboardPage> {
        await page.goto('/dashboard');
        return new DashboardPage(page);
    }

    constructor(page: Page) {
        this.userMenu = new UserMenuPage(page);
    }
}
