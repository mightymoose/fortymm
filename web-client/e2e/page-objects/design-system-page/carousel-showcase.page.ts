import { Locator, Page } from '@playwright/test';

/**
 * Carousel showcase (#268 / #831). Every locator is scoped to the carousel
 * itself (`[data-slot="carousel"]`) — the page also renders a Pagination widget
 * with its own Next/Previous buttons and other `NN / NN` text, which a
 * page-level locator would ambiguously match.
 */
export class CarouselShowcasePage {
    private readonly carousel: Locator;
    public readonly next: Locator;
    public readonly previous: Locator;

    constructor(page: Page) {
        this.carousel = page.locator('[data-slot="carousel"]');
        this.next = this.carousel.getByRole('button', { name: 'Next slide' });
        this.previous = this.carousel.getByRole('button', {
            name: 'Previous slide',
        });
    }

    /** The `NN / NN` counter (e.g. `02 / 05`), scoped to the carousel card. */
    counter(): Locator {
        return this.carousel.getByText(/^\d{2} \/ \d{2}$/);
    }

    /** The numerator of the counter as a number (1-based). */
    async counterNumerator(): Promise<number> {
        const text = (await this.counter().innerText()).trim();
        return Number(text.split('/')[0]!.trim());
    }

    /** The number displayed on the highlighted slide (the inner div carrying the
     *  `border-2` selected treatment). By construction this equals the counter
     *  numerator when the showcase is correct. */
    async highlightedSlideNumber(): Promise<number> {
        const selected = this.carousel.locator(
            '[data-slot="carousel-item"] .border-2',
        );
        const text = (await selected.innerText()).trim();
        return Number(text);
    }
}
