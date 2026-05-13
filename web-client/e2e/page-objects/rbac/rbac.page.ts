import type { Locator, Page } from '@playwright/test'
import { RbacStore, toast, type SeedSpec } from './rbac-store'

/**
 * Shared base for the three RBAC admin page objects. Subclasses add their own
 * page-specific locators; common ones (search, error boundary, toast) live here.
 */
export class RbacPage {
  constructor(public readonly page: Page, public readonly store: RbacStore) {}

  get errorBoundary(): Locator {
    return this.page.getByText('Something went wrong loading this page')
  }
  get tryAgain(): Locator {
    return this.page.getByRole('button', { name: 'Try again' })
  }
  toast(): Locator {
    return toast(this.page)
  }
}

/**
 * Mocks all RBAC endpoints with `seed` data, navigates to `path`, and returns
 * an instance of `PageObject` bound to the page + store.
 */
export async function openRbacPage<T extends RbacPage>(
  PageObject: new (page: Page, store: RbacStore) => T,
  page: Page,
  path: string,
  seed: SeedSpec = {},
): Promise<{ pom: T; store: RbacStore }> {
  const store = new RbacStore(seed)
  await store.install(page)
  await page.goto(path)
  return { pom: new PageObject(page, store), store }
}
