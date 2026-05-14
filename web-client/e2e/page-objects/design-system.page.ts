import { Page } from "@playwright/test";
import { ButtonShowcasePage } from "./design-system-page/button-showcase.page";
import { InputShowcasePage } from "./design-system-page/input-showcase.page";
import {
    OverlayShowcasePage,
    SheetShowcasePage,
} from "./design-system-page/overlay-showcase.page";
import { FeedbackShowcasePage } from "./design-system-page/feedback-showcase.page";

export class DesignSystemPage {
    public readonly buttonShowcase: ButtonShowcasePage;
    public readonly inputShowcase: InputShowcasePage;
    public readonly overlayShowcase: OverlayShowcasePage;
    public readonly sheetShowcase: SheetShowcasePage;
    public readonly feedbackShowcase: FeedbackShowcasePage;

    static async navigateTo(page: Page): Promise<DesignSystemPage> {
        // Set DESIGN_SYSTEM_KIT to a file:// URL of "FortyMM shadcn kit.html"
        // to point the showcase screenshots at the design kit instead of the
        // app — used to (re)capture baseline snapshots from the design sheet.
        await page.goto(process.env.DESIGN_SYSTEM_KIT ?? '/design-system');
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

        this.feedbackShowcase = new FeedbackShowcasePage(page);
    }
}
