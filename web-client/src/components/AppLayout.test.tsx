import { screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AppLayoutPage } from './AppLayout.page.tsx'

test('the layout shows the top bar and the sidebar, and its content in the page’s one main landmark', async () => {
  const page = new AppLayoutPage()
  page.render(<h1>A screen</h1>)

  expect(await page.brand()).toBeVisible()
  expect(await page.navigation()).toBeVisible()
  const main = await page.main()
  expect(screen.getAllByRole('main')).toEqual([main])
  expect(
    within(main).getByRole('heading', { level: 1, name: 'A screen' }),
  ).toBeVisible()
})
