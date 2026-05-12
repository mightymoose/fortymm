import { Page } from "@playwright/test";
import { ButtonShowcasePage } from "./design-system-page/button-showcase.page";

export class DesignSystemPage {
    public readonly buttonShowcase: ButtonShowcasePage;

    static async navigateTo(page: Page): Promise<DesignSystemPage> {
        await page.goto('/design-system');
        return new DesignSystemPage(page);
    }

    constructor(page: Page) {
        const buttonShowcaseContainer = page.getByRole('region', { name: 'Button' });
        this.buttonShowcase = new ButtonShowcasePage(buttonShowcaseContainer);
    }
}