import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { Disclosure } from './Disclosure.tsx'

const summary = () => screen.getByText('Entry fees')
const details = () => screen.getByText('Free.')

test('a disclosure shows only its summary until it is opened', () => {
  render(<Disclosure summary="Entry fees">Free.</Disclosure>)

  expect(summary()).toBeVisible()
  expect(details()).not.toBeVisible()
})

test('clicking the summary opens the disclosure, and clicking again closes it', async () => {
  const user = userEvent.setup()
  render(<Disclosure summary="Entry fees">Free.</Disclosure>)

  await user.click(summary())
  expect(details()).toBeVisible()

  await user.click(summary())
  expect(details()).not.toBeVisible()
})

test('a disclosure open at first shows what it holds', () => {
  render(
    <Disclosure summary="Entry fees" defaultOpen>
      Free.
    </Disclosure>,
  )

  expect(details()).toBeVisible()
})
