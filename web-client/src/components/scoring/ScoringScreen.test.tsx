import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { Score } from '../../scoring/scoring.ts'
import { ScoringScreenPage } from './ScoringScreen.page.tsx'
import type { ScoringScreenProps } from './ScoringScreen.tsx'

function props(overrides: Partial<ScoringScreenProps> = {}): ScoringScreenProps {
  return {
    opponentName: 'Ana',
    bestOf: 5,
    games: [],
    game: 1,
    gameLink: (n) => ({ to: '/', hash: `game-${n}` }),
    onSave: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  }
}

const twoGames: Score[] = [
  [11, 7],
  [9, 11],
]

test('the journey: game 1 typed by keyboard and saved, corrected from the scoreline, and a deuce score refused', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.renderMatch({ opponentName: 'Ana', bestOf: 5, games: [] })
  expect(await page.heading()).toHaveTextContent('Enter game 1 score.')

  await user.keyboard('11{Enter}7{Enter}')

  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(page.tally()).toHaveTextContent('Games won: 1 – 0')

  await user.click((await page.cellLink(1))!)
  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs('Ana')).toHaveValue('7')
  await user.keyboard('11{Enter}9{Enter}')

  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(await page.cellLink(1)).toHaveAccessibleName('Game 1, 11–9')
  await user.keyboard('10{Enter}11{Enter}')
  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(page.error()).toHaveTextContent(
    'At 10–10 the game enters deuce — the winner must lead by 2.',
  )
})

test('a valid score calls onSave once with the game and the score, inside the submit itself', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn()
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 3, onSave }))
  await user.type(await page.yours(), '11')
  await user.type(await page.theirs('Ana'), '8')

  // No await between the submit and the check: a save that waits for
  // anything (React Hook Form's async handleSubmit) is not called yet.
  fireEvent.submit(await screen.findByRole('form', { name: 'Game 3 score' }))

  expect(onSave).toHaveBeenCalledTimes(1)
  expect(onSave).toHaveBeenCalledWith(3, [11, 8])
})

test.each([
  {
    score: '11–10',
    yours: '11',
    theirs: '10',
    reason: 'At 10–10 the game enters deuce — the winner must lead by 2.',
  },
  {
    score: '12–9',
    yours: '12',
    theirs: '9',
    reason: 'A game can only go past 11 once both sides reach 10.',
  },
  {
    score: '10–10',
    yours: '10',
    theirs: '10',
    reason: 'The winning side must reach at least 11 points.',
  },
  {
    score: '(empty)–(empty)',
    yours: '',
    theirs: '',
    reason: 'Enter both scores to save this game.',
  },
  {
    score: '11–(empty)',
    yours: '11',
    theirs: '',
    reason: 'Enter both scores to save this game.',
  },
])('$score saves nothing and shows its reason, only once submitted', async ({
  yours,
  theirs,
  reason,
}) => {
  const user = userEvent.setup()
  const onSave = vi.fn()
  const page = new ScoringScreenPage()
  page.render(props({ onSave }))
  if (yours) await user.type(await page.yours(), yours)
  if (theirs) await user.type(await page.theirs('Ana'), theirs)
  expect(page.error()).toBeNull()

  await user.click(await page.submit())

  expect(page.error()).toHaveTextContent(reason)
  expect(await page.yours()).toHaveAccessibleDescription(reason)
  expect(onSave).not.toHaveBeenCalled()
})

test('the submit is never disabled, and after a refused submit the error follows what is typed', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(props())
  expect(await page.submit()).toBeEnabled()

  await user.click(await page.submit())
  expect(page.error()).not.toBeNull()
  await user.type(await page.yours(), '11')
  await user.type(await page.theirs('Ana'), '4')

  expect(page.error()).toBeNull()
})

test.each([
  { side: 'yours', fixed: '12' },
  { side: 'theirs', fixed: '9' },
] as const)(
  'a refused score is one error on the pair: fixing $side alone clears it from both fields',
  async ({ side, fixed }) => {
    const user = userEvent.setup()
    const page = new ScoringScreenPage()
    page.render(props())
    await user.type(await page.yours(), '11')
    await user.type(await page.theirs('Ana'), '10')
    await user.click(await page.submit())
    const deuce = 'At 10–10 the game enters deuce — the winner must lead by 2.'
    expect(page.error()).toHaveTextContent(deuce)
    expect(await page.yours()).toBeInvalid()
    expect(await page.theirs('Ana')).toBeInvalid()
    expect(await page.theirs('Ana')).toHaveAccessibleDescription(deuce)

    const field = side === 'yours' ? await page.yours() : await page.theirs('Ana')
    await user.clear(field)
    await user.type(field, fixed)

    expect(page.error()).toBeNull()
    expect(await page.yours()).toBeValid()
    expect(await page.theirs('Ana')).toBeValid()
    expect(await page.yours()).not.toHaveAccessibleDescription()
    expect(await page.theirs('Ana')).not.toHaveAccessibleDescription()
  },
)

test('a refused score that is changed and still refused keeps its error, now with the new reason', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(props())
  await user.type(await page.yours(), '11')
  await user.type(await page.theirs('Ana'), '10')
  await user.click(await page.submit())

  await user.clear(await page.yours())
  await user.type(await page.yours(), '10')

  expect(page.error()).toHaveTextContent('The winning side must reach at least 11 points.')
  expect(await page.yours()).toBeInvalid()
  expect(await page.theirs('Ana')).toBeInvalid()
})

test('the fields keep digits only', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(props())

  await user.type(await page.yours(), '1a-1.')

  expect(await page.yours()).toHaveValue('11')
})

test('the screen opens with your field focused; Enter there moves to the opponent’s, ArrowLeft back, ArrowRight forward', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn()
  const page = new ScoringScreenPage()
  page.render(props({ onSave }))
  expect(await page.yours()).toHaveFocus()

  await user.keyboard('11{Enter}')
  expect(await page.theirs('Ana')).toHaveFocus()
  // It moved, and didn't submit (a refused submit would focus the empty
  // field too, and show the error).
  expect(page.error()).toBeNull()
  expect(onSave).not.toHaveBeenCalled()

  await user.keyboard('{ArrowLeft}')
  expect(await page.yours()).toHaveFocus()
  await user.keyboard('{ArrowRight}')
  expect(await page.theirs('Ana')).toHaveFocus()
})

test('pressing into a field that holds a score selects it, so typing replaces it', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 1 }))

  await user.click(await page.theirs('Ana'))
  await user.keyboard('9')

  expect(await page.theirs('Ana')).toHaveValue('9')
})

test('opening a saved game selects your score, so typing replaces it', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 1 }))
  expect(await page.yours()).toHaveFocus()

  await user.keyboard('12')

  expect(await page.yours()).toHaveValue('12')
})

test('the heading says Enter for a game not saved, Edit for a saved one, with its score in the fields', async () => {
  const page = new ScoringScreenPage()
  const { unmount } = page.render(props({ games: twoGames, game: 3 }))
  expect(await page.heading()).toHaveTextContent('Enter game 3 score.')
  expect(await page.yours()).toHaveValue('')
  unmount()

  page.render(props({ games: twoGames, game: 2 }))
  expect(await page.heading()).toHaveTextContent('Edit game 2 score.')
  expect(await page.yours()).toHaveValue('9')
  expect(await page.theirs('Ana')).toHaveValue('11')
})

test.each([
  {
    state: 'game 1 of a best of 5',
    overrides: {},
    typed: null,
    label: 'Save game & next',
    subtitle: 'Save this game to continue to game 2.',
  },
  {
    state: 'a later game',
    overrides: { games: twoGames, game: 3 },
    typed: null,
    label: 'Save game & next',
    subtitle: 'Save this game to continue to game 4.',
  },
  {
    state: 'the last possible game',
    overrides: {
      games: [...twoGames, [11, 3], [4, 11]] as Score[],
      game: 5,
    },
    typed: null,
    label: 'Save final game',
    subtitle: 'Final game. Save it to finish the match.',
  },
  {
    state: 'a single game',
    overrides: { bestOf: 1 as const },
    typed: null,
    label: 'Save game',
    subtitle: 'Save this game to finish the match.',
  },
  {
    state: 'a score that would decide the match',
    overrides: { games: [[11, 7], [11, 9]] as Score[], game: 3 },
    typed: ['11', '5'],
    label: 'Finish match',
    subtitle: 'This score finishes the match.',
  },
  {
    state: 'a score that would not decide it',
    overrides: { games: [[11, 7], [11, 9]] as Score[], game: 3 },
    typed: ['5', '11'],
    label: 'Save game & next',
    subtitle: 'Save this game to continue to game 4.',
  },
  {
    state: 'a saved game',
    overrides: { games: twoGames, game: 1 },
    typed: null,
    label: 'Save changes',
    subtitle: 'Save updates the score for this game.',
  },
] satisfies {
  state: string
  overrides: Partial<ScoringScreenProps>
  typed: [string, string] | null
  label: string
  subtitle: string
}[])(
  'for $state, the submit says “$label” and the line beside it “$subtitle”',
  async ({ overrides, typed, label, subtitle }) => {
    const user = userEvent.setup()
    const page = new ScoringScreenPage()
    page.render(props(overrides))
    if (typed !== null) {
      await user.type(await page.yours(), typed[0])
      await user.type(await page.theirs('Ana'), typed[1])
    }

    expect(await page.submit()).toHaveAccessibleName(label)
    expect(await page.subtitle(subtitle)).toBeVisible()
  },
)

test('the scoreline: a cell per game, saved ones linking with their score, the next one linking, the rest inert, the current one marked', async () => {
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 1 }))

  expect(await page.cell(5)).toBeDefined()
  expect(await page.cell(1)).toHaveAttribute('aria-current', 'step')
  for (const n of [2, 3, 4, 5])
    expect(await page.cell(n)).not.toHaveAttribute('aria-current')
  // The current game is open already: no link to itself.
  expect(await page.cellLink(1)).toBeNull()
  expect(await page.cellLink(2)).toHaveAccessibleName('Game 2, 9–11')
  expect(await page.cellLink(2)).toHaveAttribute('href', '/#game-2')
  expect(await page.cellLink(3)).toHaveAccessibleName('Game 3, not yet played')
  expect(await page.cellLink(3)).toHaveAttribute('href', '/#game-3')
  expect(await page.cellLink(4)).toBeNull()
  expect(await page.cellLink(5)).toBeNull()
})

test('Clear is offered only on the highest saved game, in the action row and as the ✕ on its cell', async () => {
  const page = new ScoringScreenPage()
  const first = page.render(props({ games: twoGames, game: 1 }))
  await page.heading()
  expect(page.clear()).toBeNull()
  expect(page.clearCell(1)).toBeNull()
  expect(page.clearCell(2)).not.toBeNull()
  first.unmount()

  const second = page.render(props({ games: twoGames, game: 3 }))
  await page.heading()
  expect(page.clear()).toBeNull()
  expect(page.clearCell(2)).not.toBeNull()
  second.unmount()

  page.render(props({ games: twoGames, game: 2 }))
  await page.heading()
  expect(page.clear()).not.toBeNull()
  expect(page.clearCell(2)).not.toBeNull()
  expect(page.clearCell(1)).toBeNull()
})

test('Clear asks “Clear game N?”: Keep score clears nothing, Clear game calls onClear with the game', async () => {
  const user = userEvent.setup()
  const onClear = vi.fn()
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 2, onClear }))
  await page.heading()

  await user.click(page.clear()!)
  expect(await page.clearDialog(2)).toHaveAccessibleDescription(
    'This deletes the saved score. You can enter it again afterwards.',
  )
  await user.click(await page.keepScore())
  expect(onClear).not.toHaveBeenCalled()

  await user.click(page.clearCell(2)!)
  await page.clearDialog(2)
  await user.click(await page.clearGame())
  expect(onClear).toHaveBeenCalledTimes(1)
  expect(onClear).toHaveBeenCalledWith(2)
})

test('leaving by a scoreline cell with a score typed and not saved asks “Leave without saving?”; Keep editing stays with it', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 3 }))
  await user.type(await page.yours(), '11')

  await user.click((await page.cellLink(1))!)

  expect(await page.leaveDialog()).toBeVisible()
  expect(await page.keepEditing()).toHaveFocus()
  await user.click(await page.keepEditing())
  expect(page.queryLeaveDialog()).toBeNull()
  expect(await page.yours()).toHaveValue('11')
})

test('in a match, Discard & leave opens the game clicked, without the score typed', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.renderMatch({ opponentName: 'Ana', bestOf: 5, games: twoGames })
  await user.type(await page.yours(), '11')

  await user.click((await page.cellLink(1))!)
  await user.click(await page.discardAndLeave())

  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs('Ana')).toHaveValue('7')
})

test('leaving with nothing typed, or a saved score typed again as it was, asks nothing', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.renderMatch({ opponentName: 'Ana', bestOf: 5, games: twoGames })

  await user.click((await page.cellLink(1))!)
  expect(page.queryLeaveDialog()).toBeNull()
  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')

  await user.keyboard('11')
  await user.click((await page.cellLink(2))!)
  expect(page.queryLeaveDialog()).toBeNull()
  expect(await page.heading()).toHaveTextContent('Edit game 2 score.')
})

test('the games won so far sit under VS, yours first; a single game has none', async () => {
  const page = new ScoringScreenPage()
  const { unmount } = page.render(
    props({ games: [...twoGames, [11, 1]], game: 4 }),
  )
  await page.heading()
  expect(page.tally()).toHaveTextContent('Games won: 2 – 1')
  unmount()

  page.render(props({ bestOf: 1 }))
  expect(await page.heading()).toBeVisible()
  expect(page.tally()).toBeNull()
})

test('the opponent is named on the right, and you on the left', async () => {
  const page = new ScoringScreenPage()
  page.render(props({ opponentName: 'Bea Okafor' }))

  expect(await page.theirs('Bea Okafor')).toBeVisible()
  expect(screen.getByText('Bea Okafor')).toBeVisible()
  expect(screen.getByText('You')).toBeVisible()
})
