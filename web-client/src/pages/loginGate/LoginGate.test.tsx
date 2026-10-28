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
    'Step 1, the older guest player’s name survives',
    'Step 1, 48 matches',
    'View all 48 matches',
    'Step 2',
    'Step 2, matches open',
    'Saving',
    'Error',
    'Long player names',
    'Done after Yes, first sign-in',
    'Done after Yes, existing account',
    'Done after Yes, the name changes',
    'Done after I manage this player',
    'Done after Remove from my account',
    'Two players: the first, oldest question',
    'Two players: Someone else played stays on player 1',
    'Two players: the next player after I manage this player',
    'Two players: done after Yes on the last one',
  ]
  const phone = 'Phone, 375px'

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
    expect(page.requirements).toHaveTextContent('Nothing offers Undo.')
  })

  it('saves the matches under the player’s own name after a first sign-in', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('Step 1, first sign-in', phone)
    expect(within(frame).getByRole('heading', { name: 'Did you play these matches?' })).toBeInTheDocument()
    expect(frame).toHaveTextContent('These 3 matches will be saved to your account under mellow mongoose 594.')
    expect(page.buttons('Step 1, first sign-in', phone).map((button) => button.textContent)).toEqual([
      'Yes, save my matches',
      'Someone else played',
    ])
  })

  it('shows 3 or fewer matches whole, with no sample label or View all', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('Step 1, sign-in to an existing account', phone)
    expect(frame).toHaveTextContent('3 matches · Oct 27')
    expect(frame).not.toHaveTextContent('Recent matches')
    expect(within(frame).queryByRole('button', { name: /^View all/ })).not.toBeInTheDocument()
    expect(frame).toHaveTextContent('These 3 matches will be added to excited egret 387.')
    expect(frame).not.toHaveTextContent('keeps its name')
  })

  it('shows 3 of a larger history, with the total, the dates and View all', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('Step 1, 48 matches', phone)
    expect(frame).toHaveTextContent('48 matches · Sep 3–Oct 27')
    expect(frame).toHaveTextContent('Showing 3 of 48')
    expect(within(frame).getAllByRole('listitem')).toHaveLength(3)
    expect(within(frame).getByRole('button', { name: 'View all 48 matches' })).toBeInTheDocument()
    expect(frame).toHaveTextContent('All 48 matches will be added to excited egret 387.')
  })

  it('pages through every match in a box that scrolls', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('View all 48 matches', phone)
    expect(within(within(frame).getByRole('region', { name: 'All matches' })).getAllByRole('listitem')).toHaveLength(20)
    expect(frame).toHaveTextContent('Showing 20 of 48')
    expect(within(frame).getByRole('button', { name: 'Load 20 more' })).toBeInTheDocument()
  })

  it('says how the account’s player’s name changes when the older guest player survives', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    expect(page.frame('Step 1, the older guest player’s name survives', phone)).toHaveTextContent(
      'These 2 matches will be added to your player. Its name changes from excited egret 387 to hardy heron 233, because hardy heron 233 is the older player.',
    )
    expect(page.frame('Done after Yes, the name changes', phone)).toHaveTextContent(
      '2 matches added. Your player is hardy heron 233 now.',
    )
  })

  it('names the player once on step 2, with the short answers', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('Step 2', phone)
    expect(frame.textContent?.match(/mellow mongoose 594/g)).toHaveLength(1)
    expect(frame).toHaveTextContent('Keep this player separate in your account.')
    expect(frame).toHaveTextContent('The player and their matches will stay in FortyMM.')
    expect(within(frame).getByRole('button', { name: 'Back' })).toBeInTheDocument()
  })

  it('shows no counter for a single player', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    for (const title of titles.slice(0, 15)) {
      expect(page.frame(title, phone)).not.toHaveTextContent(/Player \d of \d/)
    }
  })

  it('stays on player 1 of 2 for Someone else played, then moves to player 2 with the answer confirmed', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    expect(page.frame('Two players: the first, oldest question', phone)).toHaveTextContent('Player 1 of 2')
    const step2 = page.frame('Two players: Someone else played stays on player 1', phone)
    expect(step2).toHaveTextContent('Player 1 of 2')
    expect(within(step2).getByRole('heading', { name: 'Do you manage this player?' })).toBeInTheDocument()
    const next = page.frame('Two players: the next player after I manage this player', phone)
    expect(next).toHaveTextContent('Player 2 of 2')
    expect(within(next).getByRole('status')).toHaveTextContent('You manage brave badger 214 now.')
  })

  it('offers no Undo after an answer', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    for (const title of titles.filter((title) => title.includes('Done') || title.includes('next player'))) {
      expect(within(page.frame(title, phone)).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    }
  })

  it('shows one short error, with the same answer as the way to try again', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('Error', phone)
    expect(within(frame).getAllByRole('alert')).toHaveLength(1)
    expect(within(frame).getByRole('alert')).toHaveTextContent('Your answer wasn’t saved. Please try again.')
    expect(within(within(frame).getByRole('alert')).queryByRole('button')).not.toBeInTheDocument()
  })
})
