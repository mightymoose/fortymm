import type { Locator, Page } from '@playwright/test'

// Page object for /options and the option previews under it, in the
// Playwright suite.
export class OptionsPage {
  readonly page: Page
  readonly title: Locator
  // The option's name, last in the breadcrumb.
  readonly optionName: Locator
  readonly loadingScreens: Locator
  readonly showAgain: Locator
  readonly finishLoading: Locator

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
    this.optionName = page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .locator('[aria-current="page"]')
    this.loadingScreens = page.getByRole('status', { name: 'Loading FortyMM' })
    this.showAgain = page.getByRole('button', { name: 'Show again' })
    this.finishLoading = page.getByRole('button', { name: 'Finish loading' })
  }

  async goto(path = '/options'): Promise<void> {
    await this.page.goto(path)
    await this.title.waitFor()
  }

  link(name: string): Locator {
    return this.page.getByRole('link', { name })
  }

  // How many pixels the page is wider than the window.
  async overflow(): Promise<number> {
    // A string, because the e2e tsconfig has no DOM types.
    return this.page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    )
  }

  // Every animation on the page, with how many times it repeats and
  // whether it's still playing.
  async animations(): Promise<{ name: string; iterations: number; playState: string }[]> {
    return this.page.evaluate(`document.getAnimations().map((animation) => ({
      name: animation.animationName ?? animation.transitionProperty ?? '',
      iterations: animation.effect.getComputedTiming().iterations,
      playState: animation.playState,
    }))`)
  }
}
