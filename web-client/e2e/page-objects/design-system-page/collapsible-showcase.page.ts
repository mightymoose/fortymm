import { Locator } from '@playwright/test';

/**
 * Collapsible showcase (#273). The "Show all" trigger must use a plain `↓`
 * glyph (U+2193), not a lucide `ChevronDown` <svg>.
 */
export class CollapsibleShowcasePage {
    public readonly showAllTrigger: Locator;

    constructor(private readonly container: Locator) {
        this.showAllTrigger = container.getByRole('button', { name: /Show all/ });
    }

    /** The trimmed text content of the trigger (includes the glyph). */
    async triggerText(): Promise<string> {
        return (await this.showAllTrigger.innerText()).trim();
    }

    /** How many <svg> elements the trigger renders (should be zero). */
    async triggerSvgCount(): Promise<number> {
        return this.showAllTrigger.locator('svg').count();
    }
}
