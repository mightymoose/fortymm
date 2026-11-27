import { type Page, type Locator  } from "@playwright/test";

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
};
