import { cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { AdoptionPage } from '../../test/pages/AdoptionPage'
import { HomePage } from '../../test/pages/HomePage'
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
const ama: AccountPlayer = {
  id: '5e4d3c2b-1a09-4f8e-8d7c-6b5a4f3e2d10',
  display_name: 'Ama Mensah',
  relationship: 'self',
  open_question: false,
}

describe('Is this you?', () => {
  it('asks who the player is right after sign-in, with focus on the first choice', async () => {
    mockVerifiedAccount([egret])
    const page = await AdoptionPage.render()

    expect(page.dialogTitle).toBe(`Who is ${egret.display_name}?`)
    expect(page.dialogText).toContain('This player was used on this device before you signed in.')
    expect(page.dialogText).not.toContain('Player 1 of')
    expect(page.choice('This is me')).toHaveFocus()
    expect(page.description('This is me')).toBe('Use this as my player profile.')
    expect(page.description('I manage this player')).toBe(
      'Manage this profile for someone else, such as my child.',
    )
    expect(page.description('Remove from my account')).toBe(
      'Disconnect this player. Their match history won’t be deleted.',
    )
  })

  it('takes signed_in out of the URL, so a reload shows only the reminder', async () => {
    mockVerifiedAccount([egret, badger])
    const page = await AdoptionPage.render()

    expect(page.dialog).not.toBeNull()
    expect(page.router.state.location.search).toEqual({})

    cleanup()
    const later = await AdoptionPage.render('/')

    expect(later.dialog).toBeNull()
    expect(later.reminderTitle).toBe('2 players to review')
    expect(later.text).toContain(
      'These players were used on this device before you signed in. Choose which belong on your account.',
    )
    await later.review()
    expect(later.dialogTitle).toBe(`Who is ${egret.display_name}?`)
  })

  it('answers only once a choice is picked', async () => {
    const api = mockVerifiedAccount([egret])
    const page = await AdoptionPage.render()

    await userEvent.click(page.continueButton)

    expect(page.continueButton).toHaveAttribute('aria-disabled', 'true')
    expect(page.dialogTitle).toBe(`Who is ${egret.display_name}?`)
    expect(api.answers).toEqual([])
  })

  it.each([
    ['This is me', 'yes', `${egret.display_name} is your player now.`],
    ['I manage this player', 'no', `You manage ${egret.display_name}.`],
    ['Remove from my account', 'not_mine', `${egret.display_name} removed from your account.`],
  ] as const)('sends %s as %s, closes and confirms it', async (label, answer, toast) => {
    const api = mockVerifiedAccount([egret])
    const page = await AdoptionPage.render()

    await page.pick(label)

    expect(api.answers).toEqual([{ playerId: egret.id, answer }])
    expect(page.dialog).toBeNull()
    expect(page.toasts).toEqual([toast])
    expect(page.reminderTitle).toBeNull()
    expect(page.text).toContain('You reviewed every player from this device.')
    expect(document.activeElement).toHaveTextContent('You reviewed every player')
  })

  it('shows the new player in the topbar after "This is me"', async () => {
    mockVerifiedAccount([egret])
    const page = await AdoptionPage.render()
    const home = new HomePage(page.router)
    expect(home.avatar(egret.display_name)).toBeNull()

    await page.pick('This is me')

    expect(home.avatar(egret.display_name)).toHaveTextContent('EE')
  })

  it('explains why "This is me" is off when the account has its own player', async () => {
    mockVerifiedAccount([ama, egret])
    const page = await AdoptionPage.render()

    expect(page.available('This is me')).toBe(false)
    expect(page.description('This is me')).toBe(
      'You already play as Ama Mensah. We can’t combine two players yet.',
    )
    expect(page.choice('I manage this player')).toHaveFocus()
  })

  it('shows progress, confirms in the dialog, and turns "This is me" off after it', async () => {
    const api = mockVerifiedAccount([egret, badger])
    const page = await AdoptionPage.render()
    expect(page.dialogText).toContain('Player 1 of 2')

    await page.pick('This is me')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'yes' }])
    expect(page.dialogTitle).toBe(`Who is ${badger.display_name}?`)
    expect(page.dialogText).toContain('Player 2 of 2')
    expect(page.dialogText).toContain(`${egret.display_name} is your player now.`)
    expect(page.available('This is me')).toBe(false)
    expect(page.description('This is me')).toBe(
      `You already play as ${egret.display_name}. We can’t combine two players yet.`,
    )
    expect(page.choice('I manage this player')).toHaveFocus()
    expect(page.continueButton).toHaveAttribute('aria-disabled', 'true')
  })

  it('skips a player without coming back to it, and Home keeps it', async () => {
    const api = mockVerifiedAccount([egret, badger])
    const page = await AdoptionPage.render()

    await page.skip()
    expect(page.dialogTitle).toBe(`Who is ${badger.display_name}?`)
    expect(page.dialogText).not.toContain('Skip this player')

    await page.pick('I manage this player')

    expect(api.answers).toEqual([{ playerId: badger.id, answer: 'no' }])
    expect(page.dialog).toBeNull()
    expect(page.reminderTitle).toBe('1 player to review')
    expect(page.text).toContain(`${egret.display_name} was used on this device before you signed in.`)
    expect(page.reviewButton).toHaveTextContent('Review player')
    expect(page.reviewButton).toHaveFocus()
  })

  it('reviews later, keeps every player on Home, and reviews them again', async () => {
    const api = mockVerifiedAccount([egret, badger])
    const page = await AdoptionPage.render()

    await page.reviewLater()

    expect(page.dialog).toBeNull()
    expect(page.reminderTitle).toBe('2 players to review')
    expect(page.reviewButton).toHaveFocus()
    expect(api.answers).toEqual([])

    await page.review()
    expect(page.dialogTitle).toBe(`Who is ${egret.display_name}?`)
  })

  it('opens no dialog without signed_in', async () => {
    mockVerifiedAccount([egret])
    const page = await AdoptionPage.render('/')

    expect(page.dialog).toBeNull()
    expect(page.reminderTitle).toBe('1 player to review')
  })

  it('says nothing to an account with no questions', async () => {
    mockVerifiedAccount([ama])
    const page = await AdoptionPage.render()

    expect(page.dialog).toBeNull()
    expect(page.reminderTitle).toBeNull()
    expect(page.text).not.toContain('You reviewed every player')
  })

  it('says a refused answer wasn’t saved, and shows the players again', async () => {
    const api = mockVerifiedAccount([egret], { refuse: 409 })
    const page = await AdoptionPage.render()

    await page.pick('I manage this player')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'no' }])
    expect(page.dialog).toBeNull()
    expect(page.toasts).toEqual(['Your answer wasn’t saved. Try again.'])
    expect(page.reminderTitle).toBe('1 player to review')
  })

  it('asks a guest for no players', async () => {
    const requests: Request[] = []
    server.use(
      http.get(`${API_BASE_URL}/v1/account/players`, ({ request }) => {
        requests.push(request)
        return HttpResponse.json({ data: [egret] })
      }),
    )
    const page = await AdoptionPage.render()

    expect(requests).toEqual([])
    expect(page.dialog).toBeNull()
    expect(page.reminderTitle).toBeNull()
  })
})
