import { Locator, Page } from '@playwright/test';

export class UserMenuPage {
    public readonly skeleton: Locator;
    public readonly menu: Locator;

    constructor(page: Page) {
        this.skeleton = page.getByTestId('user-menu-skeleton');
        this.menu = page.getByRole('button', { name: 'User menu' });
    }

    async isLoading(): Promise<boolean> {
        return this.skeleton.isVisible();
    }
}
