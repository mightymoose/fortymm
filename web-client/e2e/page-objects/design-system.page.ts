import { Page } from "@playwright/test";
import { ButtonShowcasePage } from "./design-system-page/button-showcase.page";
import { InputShowcasePage } from "./design-system-page/input-showcase.page";
import {
    OverlayShowcasePage,
    SheetShowcasePage,
} from "./design-system-page/overlay-showcase.page";
import { FeedbackShowcasePage } from "./design-system-page/feedback-showcase.page";
import { CarouselShowcasePage } from "./design-system-page/carousel-showcase.page";
import { DatePickerShowcasePage } from "./design-system-page/date-picker-showcase.page";
import { CollapsibleShowcasePage } from "./design-system-page/collapsible-showcase.page";
import { TooltipShowcasePage } from "./design-system-page/tooltip-showcase.page";

/** An element wider than a threshold whose right edge spills past the viewport
 *  without any overflow-clipping ancestor — an unclipped horizontal overflow. */
export interface OverflowingElement {
    tag: string;
    className: string;
    right: number;
    width: number;
}

export class DesignSystemPage {
    public readonly buttonShowcase: ButtonShowcasePage;
    public readonly inputShowcase: InputShowcasePage;
    public readonly overlayShowcase: OverlayShowcasePage;
    public readonly sheetShowcase: SheetShowcasePage;
    public readonly feedbackShowcase: FeedbackShowcasePage;
    public readonly carouselShowcase: CarouselShowcasePage;
    public readonly datePickerShowcase: DatePickerShowcasePage;
    public readonly collapsibleShowcase: CollapsibleShowcasePage;
    public readonly tooltipShowcase: TooltipShowcasePage;

    static async navigateTo(page: Page): Promise<DesignSystemPage> {
        // Set DESIGN_SYSTEM_KIT to a file:// URL of "FortyMM shadcn kit.html"
        // to point the showcase screenshots at the design kit instead of the
        // app — used to (re)capture baseline snapshots from the design sheet.
        await page.goto(process.env.DESIGN_SYSTEM_KIT ?? '/design-system');
        return new DesignSystemPage(page);
    }

    constructor(private readonly page: Page) {
        const buttonShowcaseContainer = page.getByRole('region', { name: 'Button' });
        this.buttonShowcase = new ButtonShowcasePage(buttonShowcaseContainer);

        const inputShowcaseContainer = page.getByRole('region', {
            name: 'Input · Label · Form Field',
        });
        this.inputShowcase = new InputShowcasePage(inputShowcaseContainer);

        const overlayShowcaseContainer = page.getByRole('region', {
            name: 'Dialog · Alert Dialog',
        });
        this.overlayShowcase = new OverlayShowcasePage(overlayShowcaseContainer);

        const sheetShowcaseContainer = page.getByRole('region', { name: 'Sheet' });
        this.sheetShowcase = new SheetShowcasePage(page, sheetShowcaseContainer);

        this.feedbackShowcase = new FeedbackShowcasePage(page);

        this.carouselShowcase = new CarouselShowcasePage(page);

        const datePickerContainer = page.getByRole('region', {
            name: 'Date Picker',
        });
        this.datePickerShowcase = new DatePickerShowcasePage(datePickerContainer);

        const collapsibleContainer = page.getByRole('region', {
            name: 'Collapsible',
        });
        this.collapsibleShowcase = new CollapsibleShowcasePage(collapsibleContainer);

        this.tooltipShowcase = new TooltipShowcasePage(page);
    }

    /** `{ scrollWidth, clientWidth }` of the document element — used to assert
     *  the page doesn't overflow horizontally at mobile width (#833). */
    async documentWidths(): Promise<{ scrollWidth: number; clientWidth: number }> {
        return this.page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        }));
    }

    /**
     * Elements wider than `minWidth` whose right edge extends past the viewport
     * without any overflow-clipping ancestor (#833). Some elements legitimately
     * spill (the carousel strip, the Table) but are clipped by an
     * `overflow: hidden|auto|scroll|clip` ancestor; those are excluded by
     * walking up the parent chain.
     */
    async unclippedOverflowingElements(
        minWidth = 40,
    ): Promise<OverflowingElement[]> {
        return this.page.evaluate((min) => {
            const viewportWidth = document.documentElement.clientWidth;
            const clips = (value: string) =>
                value === 'hidden' ||
                value === 'auto' ||
                value === 'scroll' ||
                value === 'clip';
            const hasClippingAncestor = (node: Element): boolean => {
                let parent = node.parentElement;
                while (parent) {
                    const style = getComputedStyle(parent);
                    if (clips(style.overflowX) || clips(style.overflowY)) return true;
                    parent = parent.parentElement;
                }
                return false;
            };
            return Array.from(document.body.querySelectorAll('*'))
                .map((el) => ({ el, rect: el.getBoundingClientRect() }))
                .filter(
                    ({ rect }) =>
                        rect.width > min && rect.right > viewportWidth + 1,
                )
                .filter(({ el }) => !hasClippingAncestor(el))
                .map(({ el, rect }) => ({
                    tag: el.tagName.toLowerCase(),
                    className:
                        typeof el.className === 'string' ? el.className : '',
                    right: rect.right,
                    width: rect.width,
                }));
        }, minWidth);
    }
}
