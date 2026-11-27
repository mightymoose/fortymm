import type { Locator, Page } from "@playwright/test";

export class HomePage {
  private readonly page: Page;
  public readonly heading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { level: 1, name: 'FortyMM' });
  }

  async goto() {
    await this.page.goto("/");
  }

  // Resolves once the service worker (production builds only) has precached the app and controls
  // this page, so later loads work with no network.
  async waitUntilAvailableOffline() {
    await this.page.waitForFunction('navigator.serviceWorker.controller !== null');
  }
};
