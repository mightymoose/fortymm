import { Locator, Page } from '@playwright/test';

export class ButtonShowcasePage {
    public readonly primaryButton: Locator;
    public readonly secondaryButton: Locator;
    public readonly outlineButton: Locator;
    public readonly ghostButton: Locator;
    public readonly destructiveButton: Locator;
    public readonly linkButton: Locator;
    public readonly disabledButton: Locator;
    public readonly smallButton: Locator;
    public readonly defaultButton: Locator;
    public readonly largeButton: Locator;
    public readonly iconButton: Locator;

    constructor(private readonly container: Locator) {
        this.primaryButton = container.getByRole('button', { name: 'Log a match' });
        this.secondaryButton = container.getByRole('button', { name: 'Save draft' });
        this.outlineButton = container.getByRole('button', { name: 'Cancel' });
        this.ghostButton = container.getByRole('button', { name: 'Skip' });
        this.destructiveButton = container.getByRole('button', { name: 'Forfeit match' });
        this.linkButton = container.getByRole('button', { name: 'Read manifesto' });
        this.disabledButton = container.getByRole('button', { name: 'Disabled' });
        this.smallButton = container.getByRole('button', { name: 'Small' });
        this.defaultButton = container.getByRole('button', { name: 'Default' });
        this.largeButton = container.getByRole('button', { name: 'Large' });
        this.iconButton = container.getByRole('button', { name: 'Add' });
    }
}