import { type Page } from '@playwright/test'

// Locators shared by the reference and app page objects, so both find things the same way.

export function sectionHeading(page: Page, name: string) {
  return page.getByRole('heading', { level: 2, name, exact: true })
}

export function sectionLink(page: Page, name: string) {
  return page
    .getByRole('navigation', { name: 'Showcase sections' })
    .getByRole('link', { name, exact: true })
}
