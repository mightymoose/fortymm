import { expect, test } from 'vitest'
import { screen } from '@testing-library/react'
import { NotFoundScreenPage } from './NotFoundScreen.page.tsx'

test('the not-found screen says nothing is at the address, and has no link of its own', async () => {
  const notFound = new NotFoundScreenPage()
  notFound.render()

  expect(await notFound.heading()).toBeVisible()
  expect(screen.getByText('There is nothing at this address.')).toBeVisible()
  expect(screen.queryAllByRole('link')).toEqual([])
})
