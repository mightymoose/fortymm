import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginGatePage, type FrameSize } from '../../test/pages/LoginGatePage'
import { LATENCY } from './gate2Data'
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
    'Yes merges into your main player',
    'Yes with no main player yet',
    'A larger history, whose third page fails once',
    'History, the first page loading (held)',
    'History, a page failed, with Retry',
    'History, every match loaded',
    'Someone else played, no managed players',
    'Someone else played, with managed players',
    'Which of your players?',
    'Saving Yes (held)',
    'Saving kindly koala 552 (held)',
    'Error on Yes',
    'Error on Someone I manage',
    'Error on kindly koala 552',
    'Long player names',
    'Long player names, Which of your players?',
    'Done after Yes',
    'Done after kindly koala 552',
    'Done after Someone I manage',
    'Done after Not someone I know',
    'Two players: player 1 of 2',
    'Two players: Which of your players? stays on player 1',
    'Two players: player 2 of 2 after the first answer',
    'Two players: the first save fails once',
    'Two players: done after the last answer',
  ]
  const phone = 'Phone, 375px'

  // The history view's observers, so a test can scroll to the end of the
  // list. jsdom has no IntersectionObserver.
  let observers: IntersectionObserverCallback[] = []
  beforeEach(() => {
    observers = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private readonly callback: IntersectionObserverCallback
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback
        }
        observe() {
          observers.push(this.callback)
        }
        disconnect() {
          observers = observers.filter((callback) => callback !== this.callback)
        }
      },
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function render() {
    const page = await LoginGatePage.render('/login-gate2')
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    return { page, user }
  }

  // Ends every simulated request that is waiting.
  async function respond() {
    await act(() => vi.advanceTimersByTimeAsync(LATENCY))
  }

  async function scrollToEnd() {
    await act(async () => {
      for (const callback of observers) {
        callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
      }
    })
  }

  function rows(frame: HTMLElement, name: string): HTMLElement[] {
    return within(within(frame).getByRole('list', { name })).queryAllByRole('listitem')
  }

  it('shows every frame at phone and desktop width', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    expect(page.frameTitles).toEqual(titles)
    for (const title of titles) {
      for (const size of sizes) expect(page.frame(title, size)).toBeInTheDocument()
    }
  })

  it('says what is simulated, and lists the backend changes', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    expect(page.requirements).toHaveTextContent('The data and the API are simulated')
    expect(page.requirements).toHaveTextContent('GET /v1/account/players')
    expect(page.requirements).toHaveTextContent('merge_into_self() keeps the player created first')
    expect(page.requirements).not.toHaveTextContent('Undo is')
  })

  it('asks one question, and Yes adds every match to the main player', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('Yes merges into your main player', phone)
    expect(within(frame).getByRole('heading', { name: 'Did you play these matches?' })).toBeInTheDocument()
    expect(frame).toHaveTextContent('Played as mellow mongoose 594')
    expect(frame).toHaveTextContent('These 3 matches will be added to excited egret 387.')
    expect(frame).not.toHaveTextContent('Recent matches')
    expect(within(frame).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Yes, these were mine',
      'Someone else played',
    ])
    expect(page.frame('Yes with no main player yet', phone)).toHaveTextContent(
      'These 3 matches will be saved to your account under mellow mongoose 594.',
    )
  })

  it('shows 3 of a larger history and says the answer covers all of it', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('A larger history, whose third page fails once', phone)
    expect(frame).toHaveTextContent('48 matches · Sep 3–Oct 27')
    expect(frame).toHaveTextContent('Showing 3 of 48')
    expect(rows(frame, 'Recent matches')).toHaveLength(3)
    expect(frame).toHaveTextContent('All 48 matches will be added to excited egret 387.')
  })

  it('fetches the history a page at a time, keeps rows on a failure and stops at the end', async () => {
    const { page, user } = await render()
    const frame = page.frame('A larger history, whose third page fails once', phone)

    await user.click(within(frame).getByRole('button', { name: 'View all 48 matches' }))
    expect(within(frame).getByRole('heading', { name: 'All 48 matches' })).toHaveFocus()
    expect(within(frame).getByRole('status')).toHaveTextContent('Loading matches…')
    expect(rows(frame, 'All matches')).toHaveLength(0)

    await respond()
    expect(rows(frame, 'All matches')).toHaveLength(20)
    await scrollToEnd()
    await scrollToEnd()
    await respond()
    expect(rows(frame, 'All matches')).toHaveLength(40)

    await scrollToEnd()
    await respond()
    expect(within(frame).getByRole('alert')).toHaveTextContent('These matches didn’t load.')
    expect(rows(frame, 'All matches')).toHaveLength(40)

    await user.click(within(frame).getByRole('button', { name: 'Retry' }))
    await respond()
    expect(rows(frame, 'All matches')).toHaveLength(48)
    expect(frame).toHaveTextContent('That’s all 48 matches.')

    await user.click(within(frame).getByRole('button', { name: 'Back' }))
    expect(within(frame).getByRole('button', { name: 'View all 48 matches' })).toHaveFocus()
    await user.click(within(frame).getByRole('button', { name: 'View all 48 matches' }))
    expect(rows(frame, 'All matches')).toHaveLength(48)
    expect(within(frame).queryByText('Loading matches…')).not.toBeInTheDocument()
  })

  it('shows the matches again on step 2, and saves Someone I manage at once when the account manages no player', async () => {
    const { page, user } = await render()
    const frame = page.frame('Yes merges into your main player', phone)

    await user.click(within(frame).getByRole('button', { name: 'Someone else played' }))
    expect(within(frame).getByRole('heading', { name: 'Who played these matches?' })).toHaveFocus()
    expect(frame.textContent?.match(/mellow mongoose 594/g)).toHaveLength(1)
    expect(rows(frame, 'Matches')).toHaveLength(3)
    expect(frame).toHaveTextContent('These matches come off your account. They stay in FortyMM.')

    await user.click(within(frame).getByRole('button', { name: /^Someone I manage/ }))
    expect(within(frame).getByRole('button', { name: /^Saving…/ })).toHaveAttribute('aria-busy', 'true')
    await respond()
    expect(within(frame).getByRole('status')).toHaveTextContent('You manage mellow mongoose 594 now.')
    expect(within(frame).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })

  it('asks which managed player, and one tap adds the matches to it', async () => {
    const { page, user } = await render()
    const frame = page.frame('Someone else played, with managed players', phone)

    await user.click(within(frame).getByRole('button', { name: /^Someone I manage/ }))
    expect(within(frame).getByRole('heading', { name: 'Which of your players played these?' })).toBeInTheDocument()
    expect(rows(frame, 'Matches')).toHaveLength(3)
    expect(within(frame).queryAllByRole('radio')).toHaveLength(0)
    expect(within(frame).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'kindly koala 55214 matches. Last against Ama Okafor on Oct 20.',
      'blithe bobcat 1726 matches. Last against Mei Tanaka on Sep 28.',
      'Someone newKeep these matches as a new player you manage.',
      'Back',
    ])

    await user.click(within(frame).getByRole('button', { name: /^kindly koala 552/ }))
    expect(within(frame).getByRole('button', { name: /^Saving…/ })).toHaveAttribute('aria-busy', 'true')
    expect(within(frame).getByRole('button', { name: /^blithe bobcat 172/ })).toHaveAttribute('aria-disabled', 'true')
    await respond()
    expect(within(frame).getByRole('status')).toHaveTextContent('3 matches added to kindly koala 552.')
  })

  it('tries the failed answer again with a tap on the same player', async () => {
    const { page, user } = await render()
    const frame = page.frame('Error on kindly koala 552', phone)

    expect(within(frame).getByRole('alert')).toHaveTextContent('Your answer wasn’t saved. Please try again.')
    expect(within(within(frame).getByRole('alert')).queryByRole('button')).not.toBeInTheDocument()

    await user.click(within(frame).getByRole('button', { name: /^kindly koala 552/ }))
    await respond()
    expect(within(frame).getByRole('status')).toHaveTextContent('3 matches added to kindly koala 552.')
  })

  it('takes the matches off the account for Not someone I know', async () => {
    const { page, user } = await render()
    const frame = page.frame('Someone else played, no managed players', phone)

    await user.click(within(frame).getByRole('button', { name: /^Not someone I know/ }))
    await respond()
    expect(within(frame).getByRole('status')).toHaveTextContent('mellow mongoose 594 removed from your account.')
  })

  it('shows progress while saving, with the other actions off', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const [saving, other] = within(page.frame('Saving Yes (held)', phone)).getAllByRole('button')
    expect(saving).toHaveTextContent('Saving…')
    expect(saving).toHaveAttribute('aria-busy', 'true')
    expect(other).toHaveAttribute('aria-disabled', 'true')
  })

  it('shows no counter for a single player', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    for (const title of titles.filter((title) => !title.startsWith('Two players'))) {
      expect(page.frame(title, phone)).not.toHaveTextContent(/Player \d of \d/)
    }
  })

  it('keeps player 1 of 2 through the follow-up, leaves the player out of its own picker, then moves on', async () => {
    const { page, user } = await render()
    const frame = page.frame('Two players: player 1 of 2', phone)

    expect(frame).toHaveTextContent('Player 1 of 2')
    await user.click(within(frame).getByRole('button', { name: 'Someone else played' }))
    expect(frame).toHaveTextContent('Player 1 of 2')
    await user.click(within(frame).getByRole('button', { name: /^Someone I manage/ }))
    await respond()

    expect(frame).toHaveTextContent('Player 2 of 2')
    expect(within(frame).getByRole('status')).toHaveTextContent('You manage brave badger 214 now.')
    expect(within(frame).getByRole('heading', { name: 'Did you play these matches?' })).toHaveFocus()

    await user.click(within(frame).getByRole('button', { name: 'Someone else played' }))
    await user.click(within(frame).getByRole('button', { name: /^Someone I manage/ }))
    expect(within(frame).getByRole('button', { name: /^brave badger 214/ })).toBeInTheDocument()
    expect(within(frame).queryByRole('button', { name: /^mellow mongoose 594/ })).not.toBeInTheDocument()
  })

  it('leaves the question’s own player out of the picker', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const frame = page.frame('Two players: Which of your players? stays on player 1', phone)
    expect(frame).toHaveTextContent('Player 1 of 2')
    expect(within(frame).queryByRole('button', { name: /^brave badger 214/ })).not.toBeInTheDocument()
  })

  it('offers no Undo when the gate ends', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    for (const title of titles.filter((title) => title.includes('Done') || title.includes('done'))) {
      expect(within(page.frame(title, phone)).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    }
    expect(screen.queryAllByRole('button', { name: 'Undo' })).toHaveLength(0)
  })

  it('links each frame to its full-screen view', async () => {
    const page = await LoginGatePage.render('/login-gate2')

    const section = screen.getByRole('region', { name: 'Someone else played, no managed players' })
    expect(within(section).getByRole('link', { name: 'Open full screen' })).toHaveAttribute(
      'href',
      '/login-gate2?frame=someone-else-played-no-managed-players',
    )
    expect(page.frameTitles).toHaveLength(titles.length)
  })

  it('shows one frame full screen, without the gallery', async () => {
    await LoginGatePage.renderFullScreen('someone-else-played-no-managed-players')

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('figure')).toHaveLength(0)
    expect(screen.getByRole('heading', { name: 'Who played these matches?' })).toBeInTheDocument()
  })
})
