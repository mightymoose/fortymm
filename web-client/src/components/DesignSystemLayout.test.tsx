import { screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { DesignSystemPage } from './DesignSystemLayout.page.tsx'

test('the design system page shows the FortyMM wordmark and the page’s level-1 heading', async () => {
  const page = new DesignSystemPage()
  page.render()

  expect(await page.wordmark()).toBeVisible()
  expect(await page.heading()).toBeVisible()
})

test('the design system page has a tab for each board of the reference sheet but Match, in the sheet’s order, each a link to its own page', async () => {
  const page = new DesignSystemPage()
  page.render()

  const links = await page.tabLinks()
  expect(
    links.map((link) => [link.textContent, link.getAttribute('href')]),
  ).toEqual([
    ['Colour', '/design-system/colour'],
    ['Type', '/design-system/type'],
    ['Foundations', '/design-system/foundations'],
    ['Controls', '/design-system/controls'],
    ['Feedback', '/design-system/feedback'],
  ])
})

test('the tab of the page at the address is the current one, and only it', async () => {
  const page = new DesignSystemPage()
  page.render({ path: '/design-system/foundations' })

  expect(await page.tab('Foundations')).toHaveAttribute('aria-current', 'page')
  for (const other of ['Colour', 'Type', 'Controls', 'Feedback']) {
    expect(await page.tab(other)).not.toHaveAttribute('aria-current')
  }
})

test('the design system page shows the current tab after its tabs', async () => {
  const page = new DesignSystemPage()
  page.render({ children: <p>The current tab</p> })

  const tabs = await page.tabs()
  const current = screen.getByText('The current tab')
  expect(current).toBeVisible()
  expect(
    tabs.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
})
