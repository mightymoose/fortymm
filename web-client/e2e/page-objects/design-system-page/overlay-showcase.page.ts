import { Locator, Page, expect } from '@playwright/test';

export class OverlayShowcasePage {
    constructor(private readonly container: Locator) {}

    // The showcase renders a static, always-open facsimile of each overlay —
    // the real portaled component can't show its open state inside a demo
    // card (it renders a full-screen backdrop). Locate the panel by its
    // heading instead of opening it.
    private async panelByHeading(name: string): Promise<Locator> {
        const panel = this.container.getByRole('heading', { name }).locator('..');
        await expect(panel).toBeVisible();
        return panel;
    }

    async dialogPanel(): Promise<Locator> {
        return this.panelByHeading('Forfeit this match?');
    }

    async alertDialogPanel(): Promise<Locator> {
        return this.panelByHeading('Delete account');
    }
}

export class SheetShowcasePage {
    constructor(
        private readonly page: Page,
        private readonly container: Locator,
    ) {}

    async sheetPanel(): Promise<Locator> {
        // Static, always-open facsimile of the right-anchored sheet (the real
        // Sheet portals a full-screen backdrop). Locate it by its heading.
        const panel = this.container
            .getByRole('heading', { name: 'Filters' })
            .locator('..');
        await expect(panel).toBeVisible();
        // TanStack Router/Query devtools render fixed-position toggle buttons
        // that can overlap the panel. Remove them so the screenshot is
        // deterministic.
        await this.page.evaluate(() => {
            document
                .querySelectorAll(
                    '.TanStackRouterDevtools, .tsqd-open-btn-container, .tsqd-parent-container',
                )
                .forEach((el) => el.remove());
        });
        return panel;
    }
}
