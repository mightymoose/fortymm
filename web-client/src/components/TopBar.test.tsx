import { screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AppLayoutPage } from './AppLayout.page.tsx'

test('the top bar’s FortyMM brand links to the start page', async () => {
  const page = new AppLayoutPage()
  page.renderTopBar()

  expect(await page.brand()).toHaveAttribute('href', '/')
})

test('the top bar’s brand is not a heading: each screen has its own', async () => {
  const page = new AppLayoutPage()
  page.renderTopBar()

  expect(await page.brand()).toBeVisible()
  expect(screen.queryAllByRole('heading')).toHaveLength(0)
})
