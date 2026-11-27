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
  // Fonts start loading only once text is laid out, and until then document.fonts reads as loaded.
  // Measuring forces that layout; then wait for the fonts it asked for, and measure the settled page.
  await item.boundingBox()
  // A string: the e2e tsconfig has no DOM types.
  await page.evaluate('document.fonts.ready.then(() => null)')
  const box = await item.boundingBox()
  if (!box) throw new Error('item is not visible')
  return {
    x: box.x - margins.left,
    y: box.y - margins.top,
    width: box.width + margins.left + margins.right,
    height: box.height + margins.top + margins.bottom,
  }
}

// A control in an example on a board, found by its role and accessible name, e.g.
// exampleControl(page, 'ex-variants', 'button', 'Reschedule').
export function exampleControl(page: Page, example: string, role: ControlRole, name: string) {
  return page.getByTestId(example).getByRole(role, { name, exact: true })
}

// A form field in an example on a board, whole (label, control and help or error), found by its
// control's accessible name, e.g. exampleField(page, 'ex-text-field', 'Club (optional)').
export function exampleField(page: Page, example: string, name: string) {
  return page.getByTestId(example).getByLabel(name, { exact: true }).locator('..')
}

// The roles of the controls exampleControl finds.
export type ControlRole = 'button' | 'link' | 'checkbox' | 'radio' | 'switch' | 'tab'

// A choice in an example on a board, whole, by its control's role and name: a checkbox's or radio's
// label, which holds the input, or a switch, which is its own label.
export function exampleChoice(
  page: Page,
  example: string,
  role: 'checkbox' | 'radio' | 'switch',
  name: string,
) {
  const control = exampleControl(page, example, role, name)
  return role === 'switch' ? control : control.locator('..')
}

// The range field in an example on a board, whole (label and slider), found by its slider.
export function exampleRangeField(page: Page, example: string) {
  return page.getByTestId(example).getByRole('slider').locator('..')
}

// One of the code inputs (fm-code) in an example on a board, whole, by its name and its place among
// the code inputs with that name: the board draws several states of one field.
export function exampleCodeInput(page: Page, example: string, name: string, index: number) {
  return page.getByTestId(example).getByRole('group', { name, exact: true }).nth(index).locator('..')
}

// A combobox field in an example on a board, whole, by its placeholder: the board draws two
// comboboxes with the same name.
export function exampleComboBoxField(page: Page, example: string, placeholder: string) {
  return page.getByTestId(example).getByPlaceholder(placeholder, { exact: true }).locator('../..')
}

// The open combobox in an example on a board, and its list.
export function exampleOpenComboBox(page: Page, example: string) {
  return page.getByTestId(example).getByRole('combobox', { expanded: true })
}
export function exampleListBox(page: Page, example: string) {
  return page.getByTestId(example).getByRole('listbox')
}

// A date field in an example on a board, whole (label, field, calendar button and help), by its
// name: the text box sits a level deeper than in other fields, beside its button.
export function exampleDateField(page: Page, example: string, name: string) {
  return page.getByTestId(example).getByRole('textbox', { name, exact: true }).locator('../..')
}

// The calendar in an example on a board, whole (heading, month and footer), found by its grid.
export function exampleCalendar(page: Page, example: string) {
  return page.getByTestId(example).getByRole('grid').locator('..')
}
