import { type Locator, type Page } from '@playwright/test'

// Locators shared by the reference and app page objects, so both find things the same way.

export function sectionHeading(page: Page, name: string) {
  return page.getByRole('heading', { level: 2, name, exact: true })
}

export function sectionLink(page: Page, name: string) {
  return page
    .getByRole('navigation', { name: 'Showcase sections' })
    .getByRole('link', { name, exact: true })
}

// One item of an example on a board (a colour swatch, a type row, …), found by its label within the
// example, e.g. exampleItem(page, 'found-colour-surfaces', 'ink-950 · bg-app').
export function exampleItem(page: Page, example: string, name: string) {
  return page.getByTestId(example).getByText(name, { exact: true }).locator('..')
}

// An element of an example on a board that is itself the item, found by its whole text, e.g.
// exampleElement(page, 'found-status-markers', 'Rest until 19:35').
export function exampleElement(page: Page, example: string, text: string) {
  return page.getByTestId(example).getByText(text, { exact: true })
}

// An image in an example on a board, found by its accessible name, e.g. an icon.
export function exampleImage(page: Page, example: string, name: string) {
  return page.getByTestId(example).getByRole('img', { name, exact: true })
}

// How far past an item's box a screenshot reaches on each side.
export interface Margins {
  top: number
  right: number
  bottom: number
  left: number
}

// The page area around an item, for screenshotting what it paints outside its own box (shadows,
// focus rings). Waits for the item and the fonts first, so the layout has settled before it is
// measured. Assumes the page is not scrolled: the item's viewport box is its page box.
export async function findAreaAround(page: Page, item: Locator, margins: Margins) {
  await item.waitFor()
  // A string: the e2e tsconfig has no DOM types.
  await page.waitForFunction("document.fonts.status === 'loaded'")
  const box = await item.boundingBox()
  if (!box) throw new Error('item is not visible')
  return {
    x: box.x - margins.left,
    y: box.y - margins.top,
    width: box.width + margins.left + margins.right,
    height: box.height + margins.top + margins.bottom,
  }
}
