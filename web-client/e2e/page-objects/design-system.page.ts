import { Page } from "@playwright/test";
import { ButtonShowcasePage } from "./design-system-page/button-showcase.page";
import { InputShowcasePage } from "./design-system-page/input-showcase.page";
import {
    OverlayShowcasePage,
    SheetShowcasePage,
} from "./design-system-page/overlay-showcase.page";

export class DesignSystemPage {
    public readonly buttonShowcase: ButtonShowcasePage;
    public readonly inputShowcase: InputShowcasePage;
    public readonly overlayShowcase: OverlayShowcasePage;
    public readonly sheetShowcase: SheetShowcasePage;

    static async navigateTo(page: Page): Promise<DesignSystemPage> {
        await page.goto('/design-system');
        return new DesignSystemPage(page);
    }

    constructor(page: Page) {
        const buttonShowcaseContainer = page.getByRole('region', { name: 'Button' });
        this.buttonShowcase = new ButtonShowcasePage(buttonShowcaseContainer);

        const inputShowcaseContainer = page.getByRole('region', {
            name: 'Input · Label · Form Field',
        });
        this.inputShowcase = new InputShowcasePage(inputShowcaseContainer);

        const overlayShowcaseContainer = page.getByRole('region', {
            name: 'Dialog · Alert Dialog',
        });
        this.overlayShowcase = new OverlayShowcasePage(
            page,
            overlayShowcaseContainer,
        );

        const sheetShowcaseContainer = page.getByRole('region', { name: 'Sheet' });
        this.sheetShowcase = new SheetShowcasePage(page, sheetShowcaseContainer);
    }
}
