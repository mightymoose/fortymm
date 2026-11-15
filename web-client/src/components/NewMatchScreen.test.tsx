import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { NewMatchScreenPage } from './NewMatchScreen.page.tsx'

test('the new match screen has its heading and a way back to the dashboard, in its breadcrumbs and as Cancel', async () => {
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })

  expect(await page.heading()).toBeVisible()
  expect(await page.breadcrumbToDashboard()).toHaveAttribute('href', '/')
  expect(await page.cancel()).toHaveAttribute('href', '/')
})

test('submitting with no opponent shows the opponent field’s error, marks it invalid, focuses it, and calls nothing', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })
  expect(page.opponentError()).toBeNull()

  await user.click(await page.startMatch())

  const opponent = await page.opponent()
  expect(opponent).toHaveAccessibleDescription('Enter your opponent’s name.')
  expect(opponent).toBeInvalid()
  expect(opponent).toHaveFocus()
  expect(onSubmit).not.toHaveBeenCalled()
})

test('a name of only spaces is no name: submitting shows the error and calls nothing', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })

  await user.type(await page.opponent(), '   ')
  await user.click(await page.startMatch())

  expect(await page.opponent()).toHaveAccessibleDescription(
    'Enter your opponent’s name.',
  )
  expect(onSubmit).not.toHaveBeenCalled()
})

test('after a failed submit, typing a name clears the error', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })
  await user.click(await page.startMatch())

  await user.type(await page.opponent(), 'Ana')

  expect(page.opponentError()).toBeNull()
  expect(await page.opponent()).toBeValid()
})

test('a complete form calls the handler once with the name, trimmed, and the format chosen', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })

  await user.type(await page.opponent(), '  Ana Silva ')
  await user.click(await page.bestOf(3))
  await user.click(await page.points(21))
  await user.click(await page.startMatch())

  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit).toHaveBeenCalledWith({
    opponentName: 'Ana Silva',
    format: { bestOf: 3, points: 21 },
  })
})

test('left as it opens, the format is best of 5, games to 11', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })
  expect(await page.bestOf(5)).toBeChecked()
  expect(await page.points(11)).toBeChecked()

  await user.type(await page.opponent(), 'Ana')
  await user.click(await page.startMatch())

  expect(onSubmit).toHaveBeenCalledWith({
    opponentName: 'Ana',
    format: { bestOf: 5, points: 11 },
  })
})

test('pressing Enter in the opponent’s field submits the form', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })

  await user.type(await page.opponent(), 'Ana{Enter}')

  expect(onSubmit).toHaveBeenCalledTimes(1)
})
