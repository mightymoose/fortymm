import { Locator, Page } from "@playwright/test";

export class LandingPage {
    public readonly heroHeading: Locator;

    static async navigateTo(page: Page): Promise<LandingPage> {
        await page.goto('/');
        return new LandingPage(page);
    }

    constructor(page: Page) {
        this.heroHeading = page.getByRole('heading', {
            level: 1,
            name: /play more\.\s*pay never\./i,
        });
    }
}
