import { Locator, Page } from '@playwright/test';

export class FeedbackShowcasePage {
    public readonly successToast: Locator;
    public readonly errorToast: Locator;
    public readonly infoToast: Locator;

    constructor(page: Page) {
        // The `.sonner-*` classes mirror the markup of the design kit
        // (FortyMM shadcn kit.html), so the same locator targets the toast
        // both in the app and in the kit when capturing baseline screenshots.
        // The showcase has two `.sonner-info` previews (Reminder, and the
        // update/Reload variant) — narrow to the Reminder text here.
        this.successToast = page.locator('.sonner-success');
        this.errorToast = page.locator('.sonner-error');
        this.infoToast = page.locator('.sonner-info', { hasText: 'Reminder' });
    }
}
