import { Locator } from '@playwright/test';

export class InputShowcasePage {
    public readonly playerTagInput: Locator;
    public readonly emailInput: Locator;
    public readonly disabledInput: Locator;
    public readonly searchInput: Locator;

    constructor(private readonly container: Locator) {
        this.playerTagInput = container.getByLabel('Player tag');
        this.emailInput = container.getByLabel(/^Email/);
        this.disabledInput = container.getByLabel('Disabled');
        this.searchInput = container.getByLabel('Search');
    }
}
