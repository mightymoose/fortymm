import { Page } from '@playwright/test';

export interface Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

/**
 * Tooltip showcase (#832). Radix portals the two always-open tooltip bubbles to
 * <body>, so they're collected page-wide rather than scoped to the showcase
 * card. The two bubbles must never overlap.
 */
export class TooltipShowcasePage {
    constructor(private readonly page: Page) {}

    /**
     * Bounding rects of every visible tooltip bubble. The 1×1px hidden a11y
     * spans Radix injects are filtered out with a width threshold. `toPass`
     * lets floating-ui finish positioning before we trust the geometry.
     */
    async bubbleRects(): Promise<Rect[]> {
        return this.page.evaluate(() =>
            Array.from(
                document.querySelectorAll(
                    '[data-slot="tooltip-content"], [role="tooltip"]',
                ),
            )
                .map((el) => {
                    const r = el.getBoundingClientRect();
                    return {
                        left: r.left,
                        top: r.top,
                        right: r.right,
                        bottom: r.bottom,
                        width: r.width,
                        height: r.height,
                    };
                })
                .filter((r) => r.width > 5),
        );
    }
}
