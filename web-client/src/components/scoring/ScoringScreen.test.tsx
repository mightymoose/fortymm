import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { Games, Score } from '../../scoring/scoring.ts'
import { ScoringScreenPage } from './ScoringScreen.page.tsx'
import type { ScoringScreenProps } from './ScoringScreen.tsx'
import { noNewVersion } from '../DeviceAlert.page.tsx'
import type { ActionResult, Failure } from '../../stores/match-source.ts'

// The store's answer to a save or a clear it kept.
async function kept(): Promise<ActionResult> {
  return { ok: true }
}

// The store's answer to one the device refused.
function refused(reason: Failure['reason']) {
  return async (): Promise<ActionResult> => ({ ok: false, reason })
}

function props(overrides: Partial<ScoringScreenProps> = {}): ScoringScreenProps {
  return {
    bestOf: 5,
    games: [],
    game: 1,
    gameLink: (n) => ({
      to: '/matches/$matchId/games/$gameId/scores/edit',
      params: { matchId: 'm', gameId: String(n) },
    }),
    onSave: vi.fn(kept),
    onSaved: vi.fn(),
    onClear: vi.fn(kept),
    newVersion: noNewVersion,
    matchPage: { to: '/matches/$matchId', params: { matchId: 'm' } },
    ...overrides,
  }
}

const edit = (n: number) => `/matches/m/games/${n}/scores/edit`

const twoGames: Score[] = [
  [11, 7],
  [9, 11],
]

test('the journey: game 3 scored first from the scoreline, then game 1, corrected, and a deuce score refused', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.renderMatch({ bestOf: 5, games: [] })
  expect(await page.heading()).toHaveTextContent('Enter game 1 score.')

  await user.click((await page.cellLink(3))!)
  expect(await page.heading()).toHaveTextContent('Enter game 3 score.')
  await user.keyboard('11{Enter}4{Enter}')

  // Saved game 3; on to the lowest empty game.
  expect(await page.heading()).toHaveTextContent('Enter game 1 score.')
  expect(await page.cellLink(3)).toHaveAccessibleName('Game 3, 11–4')
  await user.keyboard('11{Enter}7{Enter}')

  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(page.tally()).toHaveTextContent('Games won: 2 – 0')

  await user.click((await page.cellLink(1))!)
  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs()).toHaveValue('7')
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
  const onSave = vi.fn(kept)
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 3, onSave }))
  await user.type(await page.yours(), '11')
  await user.type(await page.theirs(), '8')

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
  const onSave = vi.fn(kept)
  const page = new ScoringScreenPage()
  page.render(props({ onSave }))
  if (yours) await user.type(await page.yours(), yours)
  if (theirs) await user.type(await page.theirs(), theirs)
  expect(page.error()).toBeNull()

  await user.click(await page.submit())

  expect(page.error()).toHaveTextContent(reason)
  expect(await page.yours()).toHaveAccessibleDescription(reason)
  expect(onSave).not.toHaveBeenCalled()
})

test('with nothing on its way, the submit is on, an invalid score included, and after a refused submit the error follows what is typed', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(props())
  expect(await page.submit()).toBeEnabled()

  await user.click(await page.submit())
  expect(page.error()).not.toBeNull()
  await user.type(await page.yours(), '11')
  await user.type(await page.theirs(), '4')

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
    await user.type(await page.theirs(), '10')
    await user.click(await page.submit())
    const deuce = 'At 10–10 the game enters deuce — the winner must lead by 2.'
    expect(page.error()).toHaveTextContent(deuce)
    expect(await page.yours()).toBeInvalid()
    expect(await page.theirs()).toBeInvalid()
    expect(await page.theirs()).toHaveAccessibleDescription(deuce)

    const field = side === 'yours' ? await page.yours() : await page.theirs()
    await user.clear(field)
    await user.type(field, fixed)

    expect(page.error()).toBeNull()
    expect(await page.yours()).toBeValid()
    expect(await page.theirs()).toBeValid()
    expect(await page.yours()).not.toHaveAccessibleDescription()
    expect(await page.theirs()).not.toHaveAccessibleDescription()
  },
)

test('a refused score that is changed and still refused keeps its error, now with the new reason', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(props())
  await user.type(await page.yours(), '11')
  await user.type(await page.theirs(), '10')
  await user.click(await page.submit())

  await user.clear(await page.yours())
  await user.type(await page.yours(), '10')

  expect(page.error()).toHaveTextContent('The winning side must reach at least 11 points.')
  expect(await page.yours()).toBeInvalid()
  expect(await page.theirs()).toBeInvalid()
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
  const onSave = vi.fn(kept)
  const page = new ScoringScreenPage()
  page.render(props({ onSave }))
  expect(await page.yours()).toHaveFocus()

  await user.keyboard('11{Enter}')
  expect(await page.theirs()).toHaveFocus()
  // It moved, and didn't submit (a refused submit would focus the empty
  // field too, and show the error).
  expect(page.error()).toBeNull()
  expect(onSave).not.toHaveBeenCalled()

  await user.keyboard('{ArrowLeft}')
  expect(await page.yours()).toHaveFocus()
  await user.keyboard('{ArrowRight}')
  expect(await page.theirs()).toHaveFocus()
})

test('pressing into a field that holds a score selects it, so typing replaces it', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 1 }))

  await user.click(await page.theirs())
  await user.keyboard('9')

  expect(await page.theirs()).toHaveValue('9')
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
  expect(await page.theirs()).toHaveValue('11')
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
    state: 'a game after a gap',
    overrides: { games: [[11, 7], null, [7, 11]] as Games, game: 4 },
    typed: null,
    label: 'Save game & next',
    subtitle: 'Save this game to continue to game 2.',
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
    state: 'an empty game before the game that decided the match',
    overrides: { games: [[11, 1], null, [11, 3], [11, 4]] as Games, game: 2 },
    typed: null,
    label: 'Save game',
    subtitle: 'The match was decided in game 4; this game was played before it.',
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
      await user.type(await page.theirs(), typed[1])
    }

    expect(await page.submit()).toHaveAccessibleName(label)
    expect(await page.subtitle(subtitle)).toBeVisible()
  },
)

test('the scoreline: a cell per game, every game of an undecided match linking, saved ones with their score, the current one marked', async () => {
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 1 }))

  expect(await page.cell(5)).toBeDefined()
  expect(await page.cell(1)).toHaveAttribute('aria-current', 'step')
  for (const n of [2, 3, 4, 5])
    expect(await page.cell(n)).not.toHaveAttribute('aria-current')
  // The current game is open already: no link to itself.
  expect(await page.cellLink(1)).toBeNull()
  expect(await page.cellLink(2)).toHaveAccessibleName('Game 2, 9–11')
  expect(await page.cellLink(2)).toHaveAttribute('href', edit(2))
  // Every empty game links, not only the next: games are scored in any order.
  for (const n of [3, 4, 5]) {
    expect(await page.cellLink(n)).toHaveAccessibleName(`Game ${n}, not yet played`)
    expect(await page.cellLink(n)).toHaveAttribute('href', edit(n))
  }
})

test('in a decided match, saved games link and an empty game after the deciding game is inert', async () => {
  const page = new ScoringScreenPage()
  page.render(props({ bestOf: 3, games: [[11, 7], [11, 4]], game: 1 }))

  expect(await page.cellLink(2)).toHaveAccessibleName('Game 2, 11–4')
  expect(await page.cellLink(3)).toBeNull()
  expect(await page.cell(3)).toHaveTextContent('Game 3, not yet played')
})

test.each([1, 2])('Clear is in the action row of saved game %i, the highest or not; the scoreline has no ✕', async (game) => {
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game }))
  await page.heading()
  expect(page.clear()).not.toBeNull()
  expect(screen.queryByRole('button', { name: /^Clear game/ })).toBeNull()
})

test('an empty game has no Clear, and the scoreline no ✕', async () => {
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 3 }))
  await page.heading()
  expect(page.clear()).toBeNull()
  expect(screen.queryByRole('button', { name: /^Clear game/ })).toBeNull()
})

test('Clear calls onClear with the game at once, asking nothing', async () => {
  const user = userEvent.setup()
  const onClear = vi.fn(kept)
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 1, onClear }))
  await page.heading()

  await user.click(page.clear()!)

  expect(onClear).toHaveBeenCalledTimes(1)
  expect(onClear).toHaveBeenCalledWith(1)
  expect(screen.queryByRole('dialog')).toBeNull()
})

// A save or a clear the test answers by hand: `action` is the handler, and
// `answer` gives the store's answer to its latest call.
function answeredByHand() {
  let give: (result: ActionResult) => void = () => {}
  const action = vi.fn(
    () =>
      new Promise<ActionResult>((resolve) => {
        give = resolve
      }),
  )
  return { action, answer: (result: ActionResult) => give(result) }
}

// The user's decision, 2026-11-18: from the press until the store answers,
// Save and Clear can't be pressed, so one press keeps one signed record.
test.each([
  { action: 'save', answer: 'kept' },
  { action: 'save', answer: 'refused' },
  { action: 'clear', answer: 'kept' },
  { action: 'clear', answer: 'refused' },
] as const)(
  'while a $action is on its way, Save and Clear are off; once it is $answer, they are on and Save saves again',
  async ({ action, answer }) => {
    const user = userEvent.setup()
    const { action: handler, answer: give } = answeredByHand()
    const page = new ScoringScreenPage()
    page.render(props({ games: twoGames, game: 1, onSave: handler, onClear: handler }))
    await page.heading()

    await user.click(action === 'save' ? await page.submit() : page.clear()!)

    expect(await page.submit()).toBeDisabled()
    expect(page.clear()).toBeDisabled()
    give(answer === 'kept' ? { ok: true } : { ok: false, reason: 'storage-unavailable' })
    await vi.waitFor(async () => expect(await page.submit()).toBeEnabled())
    expect(page.clear()).toBeEnabled()
    // A kept clear empties the fields: a score to save.
    await user.clear(await page.yours())
    await user.type(await page.yours(), '11')
    await user.clear(await page.theirs())
    await user.type(await page.theirs(), '7')
    await user.click(await page.submit())
    expect(handler).toHaveBeenCalledTimes(2)
  },
)

// Two presses in one go, before React has drawn the first one's disabled
// buttons: a double tap, or Enter pressed again at once.
test.each(['Save', 'Clear'])(
  '%s pressed twice before the first is answered calls the store once',
  async (button) => {
    const onSave = answeredByHand().action
    const onClear = answeredByHand().action
    const page = new ScoringScreenPage()
    page.render(props({ games: twoGames, game: 1, onSave, onClear }))
    const form = await screen.findByRole('form', { name: 'Game 1 score' })
    const clear = page.clear()!

    act(() => {
      if (button === 'Save') {
        fireEvent.submit(form)
        fireEvent.submit(form)
      } else {
        clear.click()
        clear.click()
      }
    })

    expect(onSave).toHaveBeenCalledTimes(button === 'Save' ? 1 : 0)
    expect(onClear).toHaveBeenCalledTimes(button === 'Clear' ? 1 : 0)
  },
)

test('in a match, Clear empties that game and stays on it, its fields empty', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.renderMatch({ bestOf: 5, games: twoGames })
  await user.click((await page.cellLink(1))!)
  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')

  await user.click(page.clear()!)

  expect(await page.heading()).toHaveTextContent('Enter game 1 score.')
  expect(await page.yours()).toHaveValue('')
  expect(await page.theirs()).toHaveValue('')
  expect(page.tally()).toHaveTextContent('Games won: 0 – 1')
  expect(screen.queryByRole('dialog')).toBeNull()
})

// Black-box #8 (approved 2026-11-18): moving to another game with a typed
// score asks, as leaving the match does.
test('moving to another game with a score typed and not saved asks “Leave without saving?”; Keep editing stays with what is typed', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.renderMatch({ bestOf: 5, games: twoGames })
  await user.click((await page.cellLink(1))!)
  await user.keyboard('5')

  await user.click((await page.cellLink(2))!)
  await page.leaveDialog()
  await user.click(await page.keepEditing())

  expect(page.queryLeaveDialog()).toBeNull()
  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')
  expect(await page.yours()).toHaveValue('5')
})

test('moving to another game with a score typed, Discard & leave opens that game and drops what was typed', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.renderMatch({ bestOf: 5, games: twoGames })
  await user.click((await page.cellLink(1))!)
  await user.keyboard('5')

  await user.click((await page.cellLink(2))!)
  await user.click(await page.discardAndLeave())

  expect(await page.heading()).toHaveTextContent('Edit game 2 score.')
  await user.click((await page.cellLink(1))!)
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs()).toHaveValue('7')
})

test('moving to another game with nothing typed asks nothing', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.renderMatch({ bestOf: 5, games: twoGames })
  await user.click((await page.cellLink(1))!)

  await user.click((await page.cellLink(2))!)

  expect(page.queryLeaveDialog()).toBeNull()
  expect(await page.heading()).toHaveTextContent('Edit game 2 score.')
})

test('leaving scoring with a score typed and not saved asks “Leave without saving?”; Keep editing stays with it', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.renderMatch({ bestOf: 5, games: twoGames })
  await user.type(await page.yours(), '11')

  await user.click(await page.dashboardLink())

  expect(await page.leaveDialog()).toBeVisible()
  expect(await page.keepEditing()).toHaveFocus()
  await user.click(await page.keepEditing())
  expect(page.queryLeaveDialog()).toBeNull()
  expect(await page.heading()).toHaveTextContent('Enter game 3 score.')
  expect(await page.yours()).toHaveValue('11')
})

// Black-box #17: staying puts focus back on the score field it left.
test.each([
  { how: 'Escape', field: 'yours' },
  { how: 'Keep editing', field: 'theirs' },
] as const)('$how on “Leave without saving?” puts focus back on the score field ($field)', async ({ how, field }) => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.renderMatch({ bestOf: 5, games: twoGames })
  await user.type(await page.yours(), '11')
  if (field === 'theirs') await user.type(await page.theirs(), '4')

  await user.click(await page.dashboardLink())
  await page.leaveDialog()
  if (how === 'Escape') await user.keyboard('{Escape}')
  else await user.click(await page.keepEditing())

  expect(page.queryLeaveDialog()).toBeNull()
  expect(await page[field]()).toHaveFocus()
})

test('leaving scoring, Discard & leave leaves', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.renderMatch({ bestOf: 5, games: twoGames })
  await user.type(await page.yours(), '11')

  await user.click(await page.dashboardLink())
  await user.click(await page.discardAndLeave())

  expect(page.queryLeaveDialog()).toBeNull()
  // The router's link to the page it is on is marked current.
  expect(await page.dashboardLink()).toHaveAttribute('aria-current', 'page')
})

test('leaving scoring with nothing typed, or a saved score typed again as it was, asks nothing', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  const first = page.renderMatch({ bestOf: 5, games: twoGames })
  await page.heading()
  await user.click(await page.dashboardLink())
  expect(page.queryLeaveDialog()).toBeNull()
  expect(await page.dashboardLink()).toHaveAttribute('aria-current', 'page')
  first.unmount()

  page.renderMatch({ bestOf: 5, games: twoGames })
  await user.click((await page.cellLink(1))!)
  await user.keyboard('11')
  await user.click(await page.dashboardLink())
  expect(page.queryLeaveDialog()).toBeNull()
  expect(await page.dashboardLink()).toHaveAttribute('aria-current', 'page')
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

test('"Anonymous" stands over the opponent’s field on the right, which is named "Opponent’s score", and "You" on the left', async () => {
  const page = new ScoringScreenPage()
  page.render(props())

  expect(await page.theirs()).toBeVisible()
  expect(screen.getByText('Anonymous')).toBeVisible()
  expect(screen.getByText('You')).toBeVisible()
})

test('a save the device refused keeps the typed score and says why; typing keeps the alert', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(props({ onSave: vi.fn(refused('signing-unavailable')) }))
  await user.type(await page.yours(), '11')
  await user.type(await page.theirs(), '7')

  await user.click(await page.submit())

  const alert = await page.alert()
  expect(alert).toHaveAccessibleName('Your browser doesn’t support saving matches')
  expect(alert).toHaveTextContent('Update your browser or try another browser.')
  // A new game: there was no saved score to speak of.
  expect(alert).not.toHaveTextContent('Your saved score')
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs()).toHaveValue('7')
  expect(page.error()).toBeNull()

  await user.type(await page.theirs(), '{Backspace}5')
  expect(page.queryAlert()).not.toBeNull()
})

test('the next Save takes the alert away when pressed', async () => {
  const user = userEvent.setup()
  let release = () => {}
  const onSave = vi
    .fn<ScoringScreenProps['onSave']>()
    .mockImplementationOnce(refused('storage-unavailable'))
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return { ok: true }
    })
  const page = new ScoringScreenPage()
  page.render(props({ onSave }))
  await user.type(await page.yours(), '11')
  await user.type(await page.theirs(), '7')
  await user.click(await page.submit())
  await page.alert()

  await user.click(await page.submit())

  expect(page.queryAlert()).toBeNull()
  release()
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
  expect(page.queryAlert()).toBeNull()
})

test('a clear the device refused says the saved score is still saved, and shows it; the next Clear takes it away', async () => {
  const user = userEvent.setup()
  const onClear = vi
    .fn<ScoringScreenProps['onClear']>()
    .mockImplementationOnce(refused('locks-unavailable'))
    .mockImplementationOnce(() => new Promise<ActionResult>(() => {}))
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 1, onClear }))
  await page.heading()

  await user.click(page.clear()!)

  const alert = await page.alert()
  expect(alert).toHaveTextContent('Your saved score is still 11–7.')
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs()).toHaveValue('7')

  await user.click(page.clear()!)
  expect(page.queryAlert()).toBeNull()
})

test('a correction the device refused says the saved score is still saved, and what to do', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(props({ games: twoGames, game: 1, onSave: vi.fn(refused('storage-unavailable')) }))
  await user.type(await page.theirs(), '{Backspace}9')

  await user.click(await page.submit())

  const alert = await page.alert()
  expect(alert).toHaveAccessibleName('Couldn’t save your score')
  expect(alert).toHaveTextContent(
    'Your saved score is still 11–7. Check that your browser allows site data and that you have free storage space, then try again.',
  )
  expect(await page.theirs()).toHaveValue('9')
})

test('a save the store’s rules refused after the screen allowed it shows their message in the error line', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(
    props({
      onSave: vi.fn(async (): Promise<ActionResult> => ({
        ok: false,
        reason: 'past-decider',
        message: "The match is already decided; game 1 can't be played.",
      })),
    }),
  )
  await user.type(await page.yours(), '11')
  await user.type(await page.theirs(), '7')

  await user.click(await page.submit())

  await vi.waitFor(() =>
    expect(page.error()).toHaveTextContent("The match is already decided; game 1 can't be played."),
  )
  expect(page.queryAlert()).toBeNull()
})

test('with a new version waiting, a save refused for the core offers Reload, says the unsaved changes go, and reloads without asking to leave', async () => {
  const user = userEvent.setup()
  const reload = vi.fn()
  const page = new ScoringScreenPage()
  page.render(
    props({ onSave: vi.fn(refused('core-unavailable')), newVersion: { waiting: true, reload } }),
    { browserHistory: true },
  )
  await user.type(await page.yours(), '11')
  await user.type(await page.theirs(), '7')
  await user.click(await page.submit())

  expect(await page.alert()).toHaveTextContent(
    'Reload FortyMM, then enter your score again. Your unsaved changes will be lost.',
  )
  // The typed score asks the browser before the page goes...
  expect(unloadAsks()).toBe(true)

  await user.click(await page.reload())

  expect(reload).toHaveBeenCalledTimes(1)
  // ...but not for the reload the person asked for.
  expect(unloadAsks()).toBe(false)
})

// After another tab's Reload, the new version already controls this page,
// and its reload is at once: the page goes in the same call.
test('a Reload that reloads at once still doesn’t ask to leave', async () => {
  const user = userEvent.setup()
  let asked: boolean | null = null
  const page = new ScoringScreenPage()
  page.render(
    props({
      onSave: vi.fn(refused('core-unavailable')),
      newVersion: { waiting: true, reload: () => (asked = unloadAsks()) },
    }),
    { browserHistory: true },
  )
  await user.type(await page.yours(), '11')
  await user.type(await page.theirs(), '7')
  await user.click(await page.submit())

  await user.click(await page.reload())

  expect(asked).toBe(false)
})

test('a clear refused for the core, with nothing typed, says nothing of unsaved changes', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  page.render(
    props({
      games: twoGames,
      game: 1,
      onClear: vi.fn(refused('core-unavailable')),
      newVersion: { waiting: true, reload: () => {} },
    }),
  )
  await page.heading()

  await user.click(page.clear()!)

  const alert = await page.alert()
  expect(alert).toHaveTextContent('Reload FortyMM, then clear your score again.')
  expect(alert).not.toHaveTextContent('unsaved')
})

// An empty game of a decided match: on the scoring page, only when the
// match was finished elsewhere while the page was open (the route sends a
// person who opens one to the dashboard). Approved default 2, 2026-11-18.
test('an empty game of a decided match: the finished notice links to the match, Save is off, and what is typed stays', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  const onSave = vi.fn(kept)
  page.render(props({ bestOf: 3, games: [[11, 7], [11, 5]], game: 3, onSave }))

  expect(await page.finished()).toBeInTheDocument()
  expect(screen.getByText('Game 3 can’t be played, so this score can’t be saved.')).toBeInTheDocument()
  expect(await page.goToMatch()).toHaveAttribute('href', '/matches/m')
  await user.type(await page.yours(), '11')
  await user.type(await page.theirs(), '3{Enter}')
  expect(await page.submit()).toBeDisabled()
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs()).toHaveValue('3')
  expect(onSave).not.toHaveBeenCalled()
})

// A game before the one that decided the match was played (a game cleared
// by mistake): no finished notice, and its score saves.
test('an empty game before the game that decided the match has no finished notice, and its score saves', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  const onSave = vi.fn(kept)
  page.render(props({ bestOf: 3, games: [[11, 1], null, [11, 3]], game: 2, onSave }))

  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(page.queryFinished()).toBeNull()
  await user.type(await page.yours(), '2')
  await user.type(await page.theirs(), '11{Enter}')
  expect(onSave).toHaveBeenCalledWith(2, [2, 11])
})

test('on a decided match, the scoreline links an empty game before the decider and not one after it', async () => {
  const page = new ScoringScreenPage()
  page.render(props({ bestOf: 5, games: [[11, 1], null, [11, 3], [11, 4]], game: 1 }))

  expect(await page.cellLink(2)).not.toBeNull()
  expect(await page.cellLink(5)).toBeNull()
})

test('a saved game of a decided match has no finished notice, and saves', async () => {
  const user = userEvent.setup()
  const page = new ScoringScreenPage()
  const onSave = vi.fn(kept)
  page.render(props({ bestOf: 3, games: [[11, 7], [11, 5]], game: 1, onSave }))
  await page.heading()

  expect(page.queryFinished()).toBeNull()
  await user.click(await page.submit())
  expect(onSave).toHaveBeenCalledWith(1, [11, 7])
})


// Whether the browser would ask before the page goes (the leave guard's
// beforeunload handler cancels the event).
function unloadAsks() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}
