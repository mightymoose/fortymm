import { within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { HomePage } from '../../test/pages/HomePage'
import { PlayerReviewPage, type ReviewAction } from '../../test/pages/PlayerReviewPage'
import { API_BASE_URL, mockVerifiedAccount, server } from '../../test/server'

type AccountPlayer = components['schemas']['AccountPlayer']

const egret: AccountPlayer = {
  id: '7d1c2f0a-3b6e-4f8a-9c2d-1e5f6a7b8c90',
  display_name: 'excited egret 387',
  relationship: 'managed',
  open_question: true,
}
const badger: AccountPlayer = {
  id: '2a9b8c7d-6e5f-4a3b-8c1d-0e9f8a7b6c54',
  display_name: 'brave badger 214',
  relationship: 'managed',
  open_question: true,
}
// The player the API gives the account after sign-in. It is the newest.
const dove: AccountPlayer = {
  id: '9f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b',
  display_name: 'dreamy dove 412',
  relationship: 'self',
  open_question: false,
}
const ama: AccountPlayer = {
  id: '5e4d3c2b-1a09-4f8e-8d7c-6b5a4f3e2d10',
  display_name: 'Ama Mensah',
  relationship: 'self',
  open_question: false,
}

const NOT_SAVED = 'Your answer wasn’t saved. Please try again.'

describe('Is this you?', () => {
  it('opens right after sign-in and asks about the first player', async () => {
    mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render('/?signed_in=1')
    await page.findQuestion()

    expect(page.href).toBe('/review-players')
    expect(page.heading).toHaveTextContent('Is this you?')
    expect(page.heading).toHaveFocus()
    expect(page.text).toContain(`${egret.display_name} was used on this device before you signed in.`)
    expect(page.answers).toHaveTextContent(
      `${egret.display_name} and ${dove.display_name} will become one player, your player.`,
    )
    expect(page.counter).toBeNull()
  })

  it('takes signed_in out of the URL when no player waits', async () => {
    mockVerifiedAccount([ama])
    const page = await PlayerReviewPage.render('/?signed_in=1')

    expect(page.href).toBe('/')
    expect(page.reminderTitle).toBeNull()
  })

  it('reminds on Home, and its link opens the review', async () => {
    mockVerifiedAccount([egret, badger, dove])
    const page = await PlayerReviewPage.render('/')

    expect(page.href).toBe('/')
    expect(page.reminderTitle).toBe('2 players to review')

    await page.review()

    expect(page.href).toBe('/review-players')
    expect(page.heading).toHaveTextContent('Is this you?')
    expect(page.counter).toBe('Player 1 of 2')
  })

  it.each([
    [['Yes, this is me'], 'yes', `${egret.display_name} is your player now.`],
    [
      ['Someone else played', 'I manage this player'],
      'no',
      `${egret.display_name} added to players you manage.`,
    ],
    [
      ['Someone else played', 'Remove from my account'],
      'not_mine',
      `${egret.display_name} removed from your account.`,
    ],
  ] as const)('sends %j as %s, then goes Home with a toast', async (clicks, answer, toast) => {
    const api = mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()

    for (const name of clicks) await page.click(name as ReviewAction)

    expect(api.answers).toEqual([{ playerId: egret.id, answer }])
    expect(page.href).toBe('/')
    expect(page.toasts).toEqual([toast])
    expect(page.reminderTitle).toBeNull()
  })

  it('confirms an answer on the page, and asks about the next player', async () => {
    const api = mockVerifiedAccount([egret, badger, dove])
    const page = await PlayerReviewPage.render()

    await page.click('Yes, this is me')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'yes' }])
    expect(page.counter).toBe('Player 2 of 2')
    expect(page.heading).toHaveTextContent('Is this you?')
    expect(page.heading).toHaveFocus()
    expect(page.notice).toBe(`${egret.display_name} is your player now.`)
    expect(page.answers).toHaveTextContent(
      `${badger.display_name} and ${egret.display_name} will become one player, your player.`,
    )
    expect(page.toasts).toEqual([])

    await page.click('Someone else played')
    await page.click('I manage this player')

    expect(api.answers).toEqual([
      { playerId: egret.id, answer: 'yes' },
      { playerId: badger.id, answer: 'no' },
    ])
    expect(page.href).toBe('/')
    expect(page.toasts).toEqual([`${badger.display_name} added to players you manage.`])
  })

  it('names the older player that "Yes" merged into, and the topbar shows it', async () => {
    const api = mockVerifiedAccount([ama, egret])
    const page = await PlayerReviewPage.render()

    await page.click('Yes, this is me')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'yes' }])
    expect(page.toasts).toEqual([`${egret.display_name} merged into Ama Mensah, your player.`])
    expect(new HomePage(page.router).avatar('Ama Mensah')).toHaveTextContent('AM')
  })

  it('shows the player in the topbar after "Yes"', async () => {
    mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()

    await page.click('Yes, this is me')

    const home = new HomePage(page.router)
    expect(home.avatar(egret.display_name)).toHaveTextContent('EE')
    expect(home.avatar(dove.display_name)).toBeNull()
  })

  it('asks whether the visitor manages the player, and goes back', async () => {
    const api = mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()

    await page.click('Someone else played')

    expect(page.heading).toHaveTextContent('Do you manage this player?')
    expect(page.heading).toHaveFocus()
    expect(page.text).toContain(egret.display_name)
    expect(page.answers).toHaveTextContent('The player and their matches will stay in FortyMM.')

    await page.click('Back')

    expect(page.heading).toHaveTextContent('Is this you?')
    expect(page.heading).toHaveFocus()
    expect(api.answers).toEqual([])
  })

  it('reviews later without an answer, and Home keeps the reminder', async () => {
    const api = mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()

    await page.click('Review later')

    expect(api.answers).toEqual([])
    expect(page.href).toBe('/')
    expect(page.reminderTitle).toBe('1 player to review')
  })

  it('says under the button that a refused answer wasn’t saved, and stays on the step', async () => {
    const api = mockVerifiedAccount([egret, dove], { refuse: 409 })
    const page = await PlayerReviewPage.render()
    await page.click('Someone else played')

    await page.click('Remove from my account')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'not_mine' }])
    expect(page.href).toBe('/review-players')
    expect(page.heading).toHaveTextContent('Do you manage this player?')
    expect(page.button('Remove from my account')).toHaveAccessibleDescription(NOT_SAVED)
    expect(page.button('I manage this player')).not.toHaveAccessibleDescription()
    expect(page.button('I manage this player')).toBeEnabled()
    expect(page.toasts).toEqual([])
  })

  it('shows Saving… while an answer saves, and holds the other actions', async () => {
    mockVerifiedAccount([egret, dove])
    let release = () => {}
    // Returns nothing once released, so mockVerifiedAccount's handler answers.
    server.use(
      http.post(`${API_BASE_URL}/v1/account/players/:playerId/answer`, async () => {
        await new Promise<void>((resolve) => (release = resolve))
      }),
    )
    const page = await PlayerReviewPage.render()

    await page.click('Yes, this is me')

    const saving = within(page.answers).getByRole('button', { name: 'Saving…' })
    expect(saving).toHaveAttribute('aria-busy', 'true')
    expect(page.button('Someone else played')).toBeDisabled()
    expect(page.button('Review later')).toBeDisabled()

    release()
    await page.settle()

    expect(page.href).toBe('/')
    expect(page.toasts).toEqual([`${egret.display_name} is your player now.`])
  })

  it('leaves for Home when no player waits', async () => {
    mockVerifiedAccount([ama])
    const page = await PlayerReviewPage.render()

    expect(page.href).toBe('/')
    expect(page.reminderTitle).toBeNull()
  })

  it('asks a guest for no players, and leaves for Home', async () => {
    const requests: Request[] = []
    server.use(
      http.get(`${API_BASE_URL}/v1/account/players`, ({ request }) => {
        requests.push(request)
        return HttpResponse.json({ data: [egret] })
      }),
    )
    const page = await PlayerReviewPage.render()

    expect(requests).toEqual([])
    expect(page.href).toBe('/')
    expect(page.reminderTitle).toBeNull()
  })
})
