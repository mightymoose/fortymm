import { within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LoginGatePage, type FrameSize } from '../../test/pages/LoginGatePage'
import type { LoginGatePath } from './GateGallery'

const sizes: FrameSize[] = ['Phone, 375px', 'Desktop, 1280px']

describe.each<LoginGatePath>(['/login-gate1', '/login-gate3'])('%s', (path) => {
  it('shows every frame at phone and desktop width', async () => {
    const page = await LoginGatePage.render(path)

    expect(page.frameTitles).toEqual([
      'Step 1, first sign-in',
      'Step 1, sign-in to an existing account',
      'Step 2',
      'Saving',
      'Error',
      'Toast after Yes, first sign-in',
      'Toast after Yes, existing account',
      'Toast after I manage this player',
      'Toast after Remove from my account',
    ])
    for (const title of page.frameTitles) {
      for (const size of sizes) expect(page.frame(title, size)).toBeInTheDocument()
    }
  })

  it.each(sizes)('asks "Were these yours?" with two answers and no way to skip, at %s', async (size) => {
    const page = await LoginGatePage.render(path)

    const frame = page.frame('Step 1, first sign-in', size)
    expect(within(frame).getByRole('heading', { name: 'Were these yours?' })).toBeInTheDocument()
    expect(page.buttons('Step 1, first sign-in', size).map((button) => button.textContent)).toEqual([
      'Yes, these were mine',
      'Someone else played these',
    ])
  })

  it('shows both players for a sign-in to an existing account', async () => {
    const page = await LoginGatePage.render(path)

    const frame = page.frame('Step 1, sign-in to an existing account', 'Phone, 375px')
    expect(frame).toHaveTextContent('mellow mongoose 594')
    expect(frame).toHaveTextContent('excited egret 387')
  })

  it('asks who played on step 2, with Back', async () => {
    const page = await LoginGatePage.render(path)

    const names = page.buttons('Step 2', 'Phone, 375px').map((button) => button.textContent)
    expect(names[0]).toMatch(/^I manage this player/)
    expect(names[1]).toMatch(/^Remove from my account/)
    expect(names[2]).toBe('Back')
  })

  it('shows progress on the tapped answer and turns the other off while saving', async () => {
    const page = await LoginGatePage.render(path)

    const [yes, other] = page.buttons('Saving', 'Phone, 375px')
    expect(yes).toHaveTextContent('Saving…')
    expect(yes).toHaveAttribute('aria-busy', 'true')
    expect(other).toHaveAttribute('aria-disabled', 'true')
  })

  it('shows the problem and Try again when the answer failed to save', async () => {
    const page = await LoginGatePage.render(path)

    const alert = within(page.frame('Error', 'Phone, 375px')).getByRole('alert')
    expect(alert).toHaveTextContent('Your answer wasn’t saved')
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('confirms each answer with a toast that offers Undo', async () => {
    const page = await LoginGatePage.render(path)

    const toast = within(page.frame('Toast after I manage this player', 'Phone, 375px')).getByRole('status')
    expect(toast).toHaveTextContent('You manage mellow mongoose 594 now.')
    expect(within(toast).getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })
})

describe('/login-gate2', () => {
  const titles = [
    'Step 1, first sign-in',
    'Step 1, sign-in to an existing account',
    'Step 2',
    'Saving',
    'Error',
    'Long player names',
    'Done after Yes, first sign-in',
    'Done after Yes, existing account',
    'Done after I manage this player',
    'Done after Remove from my account',
    'Two players: the first, oldest question',
    'Two players: Someone else played stays on player 1',
    'Two players: the next player after I manage this player',
    'Two players: done after Yes on the last one',
  ]

  it('shows every frame at phone and desktop width', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    expect(page.frameTitles).toEqual(titles)
    for (const title of titles) {
      for (const size of sizes) expect(page.frame(title, size)).toBeInTheDocument()
    }
  })

  it('lists what the real gate must do, and says the frames don’t do it', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    expect(page.requirements).toHaveTextContent('nothing on this page runs them')
    expect(page.requirements).toHaveTextContent('GET /v1/account/players')
  })

  it('saves the matches under the player’s own name after a first sign-in', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('Step 1, first sign-in', 'Phone, 375px')
    expect(within(frame).getByRole('heading', { name: 'Did you play these matches?' })).toBeInTheDocument()
    expect(frame).toHaveTextContent('These 3 matches will be saved to your account under mellow mongoose 594.')
    expect(page.buttons('Step 1, first sign-in', 'Phone, 375px').map((button) => button.textContent)).toEqual([
      'Yes, save my matches',
      'Someone else played',
    ])
  })

  it('adds the matches to the account’s player on an existing account', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('Step 1, sign-in to an existing account', 'Phone, 375px')
    expect(frame).toHaveTextContent('These 3 matches will be added to excited egret 387.')
    expect(within(frame).getByRole('button', { name: 'Yes, add to my player' })).toBeInTheDocument()
    expect(frame).not.toHaveTextContent('keeps its name')
  })

  it('shows no counter for a single player', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    for (const title of titles.slice(0, 6)) {
      expect(page.frame(title, 'Phone, 375px')).not.toHaveTextContent(/Player \d of \d/)
    }
  })

  it('stays on player 1 of 2 for Someone else played, then moves to player 2 with the answer confirmed', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    expect(page.frame('Two players: the first, oldest question', 'Phone, 375px')).toHaveTextContent('Player 1 of 2')
    const step2 = page.frame('Two players: Someone else played stays on player 1', 'Phone, 375px')
    expect(step2).toHaveTextContent('Player 1 of 2')
    expect(within(step2).getByRole('heading', { name: 'Do you manage this player?' })).toBeInTheDocument()
    const next = page.frame('Two players: the next player after I manage this player', 'Phone, 375px')
    expect(next).toHaveTextContent('Player 2 of 2')
    expect(within(next).getByRole('status')).toHaveTextContent('You manage brave badger 214 now.')
  })

  it('labels a sample of the matches apart from the total', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('Two players: the first, oldest question', 'Phone, 375px')
    expect(frame).toHaveTextContent('Recent matches3 of 5')
    expect(frame).toHaveTextContent('These 5 matches will be added to excited egret 387.')
  })

  it('shows one error with the same answer as the way to try again', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('Error', 'Phone, 375px')
    expect(within(frame).getAllByRole('alert')).toHaveLength(1)
    expect(within(frame).getByRole('alert')).toHaveTextContent('tap Yes, add to my player again')
  })
})
