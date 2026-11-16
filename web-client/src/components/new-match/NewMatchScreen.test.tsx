import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { NewMatchScreenPage } from './NewMatchScreen.page.tsx'

test('the new match screen has its heading, the match length, and Cancel back to the dashboard', async () => {
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })

  expect(await page.heading()).toBeVisible()
  expect(await page.bestOf(5)).toBeChecked()
  expect(await page.cancel()).toHaveAttribute('href', '/')
})

test('the form asks no opponent’s name and has no rated control', async () => {
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })

  expect(await page.textboxes()).toEqual([])
  expect(await page.toggles()).toEqual([])
})

test('nothing on the form speaks of a name or of rating a match', async () => {
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })

  const text = (await page.form()).textContent
  expect(text).not.toMatch(/name/i)
  // "Unrated" is the one word of rating it may say.
  expect(text).not.toMatch(/\brat(ed|ing|e)\b/i)
})

test('Start match on a form left as it opens hands an unrated best of 5', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })

  await user.click(await page.startMatch())

  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit).toHaveBeenCalledWith({ format: { bestOf: 5 }, rated: false })
})

test('Start match hands the length chosen, unrated', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })

  await user.click(await page.bestOf(3))
  await user.click(await page.startMatch())

  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit).toHaveBeenCalledWith({ format: { bestOf: 3 }, rated: false })
})

test('the summary says who plays, You vs Anonymous, the length chosen, and Unrated', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })
  expect(await page.summary()).toHaveTextContent('Ready: You vs Anonymous')
  expect(await page.summaryDetails()).toHaveTextContent(
    'Best of 5 · first to 3 · Unrated · games to 11, win by 2',
  )

  await user.click(await page.bestOf(1))

  expect(await page.summaryDetails()).toHaveTextContent(
    'Single game · Unrated · games to 11, win by 2',
  )
})

test('Cancel on a form left as it opened leaves with no question', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })

  await user.click(await page.cancel())

  expect(page.queryDiscardDialog()).toBeNull()
})

test('Cancel on a form changed and changed back to how it opened leaves with no question', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })
  await user.click(await page.bestOf(7))

  await user.click(await page.bestOf(5))
  await user.click(await page.cancel())

  expect(page.queryDiscardDialog()).toBeNull()
})

test('Cancel with the length changed asks “Discard changes?”, its focus on Keep editing', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })
  await user.click(await page.bestOf(7))

  await user.click(await page.cancel())

  expect(await page.discardDialog()).toBeVisible()
  expect(await page.keepEditing()).toHaveFocus()
})

test('Keep editing, or Escape, closes the question and keeps what was chosen', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })
  await user.click(await page.bestOf(7))

  await user.click(await page.cancel())
  await user.click(await page.keepEditing())
  expect(page.queryDiscardDialog()).toBeNull()

  await user.click(await page.cancel())
  await page.discardDialog()
  await user.keyboard('{Escape}')
  expect(page.queryDiscardDialog()).toBeNull()

  expect(await page.bestOf(7)).toBeChecked()
})
