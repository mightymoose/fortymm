import { Locator, Page, expect } from '@playwright/test';

export class OverlayShowcasePage {
    constructor(
        private readonly page: Page,
        private readonly container: Locator,
    ) {}

    async openDialog(): Promise<Locator> {
        await this.container
            .getByRole('button', { name: 'Open dialog' })
            .click();
        const dialog = this.page.getByRole('dialog', {
            name: 'Forfeit this match?',
        });
        await expect(dialog).toBeVisible();
        return dialog;
    }

    async openAlertDialog(): Promise<Locator> {
        await this.container
            .getByRole('button', { name: 'Delete account…' })
            .click();
        const dialog = this.page.getByRole('alertdialog', {
            name: 'Delete account',
        });
        await expect(dialog).toBeVisible();
        return dialog;
    }
}

export class SheetShowcasePage {
    constructor(
        private readonly page: Page,
        private readonly container: Locator,
    ) {}

    async openSheet(): Promise<Locator> {
        await this.container
            .getByRole('button', { name: 'Open filters' })
            .click();
        const sheet = this.page.getByRole('dialog', { name: 'Filters' });
        await expect(sheet).toBeVisible();
        // TanStack Router/Query devtools render fixed-position toggle buttons
        // that overlap a right-side sheet. Remove them after the sheet has
        // opened so the screenshot is deterministic.
        await this.page.evaluate(() => {
            document
                .querySelectorAll(
                    '.TanStackRouterDevtools, .tsqd-open-btn-container, .tsqd-parent-container',
                )
                .forEach((el) => el.remove());
        });
        return sheet;
    }
}
