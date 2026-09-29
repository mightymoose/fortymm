import { Locator, Page } from "@playwright/test";
import { UserMenuPage } from "./dashboard-page/user-menu.page";

export class DashboardPage {
    public readonly userMenu: UserMenuPage;
    private readonly page: Page;

    static async navigateTo(page: Page): Promise<DashboardPage> {
        await page.goto('/dashboard');
        return new DashboardPage(page);
    }

    constructor(page: Page) {
        this.userMenu = new UserMenuPage(page);
        this.page = page;
    }

    // ----- open-checkout bar (#1809) --------------------------------------
    //
    // Mounted in `app-shell.tsx` under the header of every signed-in `_app`
    // page (dashboard included), so it is asserted through this page object
    // rather than a checkout-specific one: its subject IS "am I on the
    // dashboard, and is a hold visible here".

    /** `<section aria-label="Open checkouts">` — absent entirely when the
     * caller holds no open checkout (never an empty state), and absent for
     * the ONE tournament whose own Events tab is on screen (its checkout
     * panel already shows that hold). */
    get openCheckoutBar(): Locator {
        return this.page.getByRole('region', { name: 'Open checkouts' });
    }

    /** The bar's one line of copy — `Checkout open · <name> · MM:SS left` while
     * the hold counts down, `Checking your payment · <name>` once a card is
     * submitted. */
    get openCheckoutSummary(): Locator {
        return this.page.getByTestId('open-checkout-summary');
    }

    /** The bar's deep link back into the held tournament's Events tab —
     * "Resume" while a hold counts down, "View" while a payment is checking. */
    get resumeCheckoutLink(): Locator {
        return this.openCheckoutBar.getByRole('link', { name: /^(Resume|View)$/ });
    }
}
