import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { NewMatchScreenPage } from './NewMatchScreen.page.tsx'

test('the new match screen has its heading, the opponent’s name field, and Cancel back to the dashboard', async () => {
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })

  expect(await page.heading()).toBeVisible()
  expect(await page.opponent()).toBeVisible()
  expect(await page.cancel()).toHaveAttribute('href', '/')
})

test('the opponent’s name is optional: not required, and described so', async () => {
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })

  const opponent = await page.opponent()
  expect(opponent).not.toBeRequired()
  expect(opponent).toHaveAccessibleDescription(
    'Optional. Leave it empty to record a match without an opponent.',
  )
})

test('Start match on a form left as it opens hands an unrated best of 5 with no opponent, and shows no error', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })

  await user.click(await page.startMatch())

  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit).toHaveBeenCalledWith({
    opponentName: null,
    format: { bestOf: 5 },
    rated: false,
  })
  expect(await page.opponent()).toBeValid()
  expect(await page.opponent()).toHaveAccessibleDescription(
    'Optional. Leave it empty to record a match without an opponent.',
  )
})

test('left as it opens but for the name, the match is best of 5, unrated', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })
  expect(await page.bestOf(5)).toBeChecked()

  await user.type(await page.opponent(), 'Ana')
  expect(await page.rated()).not.toBeChecked()
  await user.click(await page.startMatch())

  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit).toHaveBeenCalledWith({
    opponentName: 'Ana',
    format: { bestOf: 5 },
    rated: false,
  })
})

test('a complete form calls the handler once with the name, trimmed, the length chosen, and rated turned on', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })

  await user.type(await page.opponent(), '  Ana Silva ')
  await user.click(await page.bestOf(3))
  await user.click(await page.rated())
  await user.click(await page.startMatch())

  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit).toHaveBeenCalledWith({
    opponentName: 'Ana Silva',
    format: { bestOf: 3 },
    rated: true,
  })
})

test('with no opponent, rated is off and disabled, described by what makes it available; a name enables it', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })

  const rated = await page.rated()
  expect(rated).toBeDisabled()
  expect(rated).not.toBeChecked()
  expect(rated).toHaveAccessibleDescription(
    'Enter your opponent’s name to make this rated.',
  )

  await user.type(await page.opponent(), 'Ana')

  expect(await page.rated()).toBeEnabled()
  expect(await page.rated()).toHaveAccessibleDescription(
    'No rating change. Still logged to history.',
  )
})

test('clearing the opponent turns rated off, and naming one again doesn’t turn it back on', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })
  await user.type(await page.opponent(), 'Ana')
  await user.click(await page.rated())
  expect(await page.rated()).toBeChecked()

  await user.clear(await page.opponent())
  expect(await page.rated()).not.toBeChecked()
  await user.type(await page.opponent(), 'Bea')
  await user.click(await page.startMatch())

  expect(await page.rated()).not.toBeChecked()
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ opponentName: 'Bea', rated: false }),
  )
})

test('the summary says who plays: Anonymous with no name, then the name typed', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })
  expect(await page.summary()).toHaveTextContent('Ready: You vs Anonymous')

  await user.type(await page.opponent(), 'Ana')

  expect(await page.summary()).toHaveTextContent('Ready: You vs Ana')
})

test('pressing Enter in the opponent’s field submits the form', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })

  await user.type(await page.opponent(), 'Ana{Enter}')

  expect(onSubmit).toHaveBeenCalledTimes(1)
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
  await user.type(await page.opponent(), 'Ana')
  await user.click(await page.rated())
  await user.click(await page.bestOf(7))

  await user.clear(await page.opponent())
  await user.click(await page.bestOf(5))
  await user.click(await page.cancel())

  expect(page.queryDiscardDialog()).toBeNull()
})

type User = ReturnType<typeof userEvent.setup>

test.each([
  {
    change: 'a name typed',
    make: async (user: User, page: NewMatchScreenPage) =>
      user.type(await page.opponent(), 'Ana'),
  },
  {
    change: 'the length changed',
    make: async (user: User, page: NewMatchScreenPage) =>
      user.click(await page.bestOf(7)),
  },
])(
  'Cancel with $change asks “Discard changes?”, its focus on Keep editing',
  async ({ make }) => {
    const user = userEvent.setup()
    const page = new NewMatchScreenPage()
    page.render({ onSubmit: vi.fn() })
    await make(user, page)

    await user.click(await page.cancel())

    expect(await page.discardDialog()).toBeVisible()
    expect(await page.keepEditing()).toHaveFocus()
  },
)

test('Keep editing, or Escape, closes the question and keeps what was entered', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn() })
  await user.type(await page.opponent(), 'Ana')

  await user.click(await page.cancel())
  await user.click(await page.keepEditing())
  expect(page.queryDiscardDialog()).toBeNull()

  await user.click(await page.cancel())
  await page.discardDialog()
  await user.keyboard('{Escape}')
  expect(page.queryDiscardDialog()).toBeNull()

  expect(await page.opponent()).toHaveValue('Ana')
})
