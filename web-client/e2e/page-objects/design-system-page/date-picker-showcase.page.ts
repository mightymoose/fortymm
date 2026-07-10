import { Locator } from '@playwright/test';

/**
 * Date Picker showcase (#261). The weekday header must read single-letter
 * abbreviations (`S M T W T F S`), not date-fns' default three-letter `EEE`.
 */
export class DatePickerShowcasePage {
    constructor(private readonly container: Locator) {}

    /**
     * The text of each weekday header cell, in column order. react-day-picker
     * puts a `rdp-weekday` class on each header cell AND a `rdp-weekdays` class
     * on the row container — both match `[class*="weekday"]`. We take only the
     * leaf elements (`children.length === 0`) so the row container's
     * concatenated `SMTWTFS` textContent doesn't get counted as a single cell.
     */
    async weekdayHeaders(): Promise<string[]> {
        return this.container.evaluate((root) =>
            Array.from(root.querySelectorAll('[class*="weekday"]'))
                .filter((el) => el.children.length === 0)
                .map((el) => el.textContent?.trim() ?? ''),
        );
    }
}
