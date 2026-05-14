import { Locator, Page } from '@playwright/test';

export class FeedbackShowcasePage {
    public readonly successToast: Locator;
    public readonly errorToast: Locator;
    public readonly infoToast: Locator;

    constructor(page: Page) {
        // The `.sonner-*` classes mirror the markup of the design kit
        // (FortyMM shadcn kit.html), so the same locator targets the toast
        // both in the app and in the kit when capturing baseline screenshots.
        this.successToast = page.locator('.sonner-success');
        this.errorToast = page.locator('.sonner-error');
        this.infoToast = page.locator('.sonner-info');
    }
}
