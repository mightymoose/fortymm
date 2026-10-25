import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Adopt3Page } from '../../test/pages/Adopt3Page'

const egret = 'excited egret 387'
const badger = 'brave badger 214'

describe('/adopt3', () => {
  it('asks who the player is after sign-in, with focus on the first choice', async () => {
    const page = await Adopt3Page.render('adopted')

    expect(page.dialogTitle).toBe(`Who is ${egret}?`)
    expect(page.dialogText).toContain('This player was used on this device before you signed in.')
    expect(page.choice('This is me')).toHaveFocus()
  })

  it('shows when the device last used the player and its recent matches', async () => {
    const page = await Adopt3Page.render('two')

    expect(page.dialogText).toContain('Last used today on this device')
    expect(page.dialogText).toContain('Won 3–1 against Kofi Owusu')

    await page.skip()

    expect(page.dialogText).toContain('Last used 3 days ago on this device')
    expect(page.dialogText).toContain('No matches yet.')
  })

  it('explains each choice inside it, and removing keeps the match history', async () => {
    const page = await Adopt3Page.render('adopted')

    expect(page.description('This is me')).toBe('Use this as my player profile.')
    expect(page.description('I manage this player')).toBe(
      'Manage this profile for someone else, such as my child.',
    )
    expect(page.description('Remove from my account')).toBe(
      'Disconnect this player. Their match history won’t be deleted.',
    )
  })

  it('answers only once a choice is picked', async () => {
    const page = await Adopt3Page.render('adopted')

    await userEvent.click(page.continueButton)

    expect(page.dialogTitle).toBe(`Who is ${egret}?`)
  })

  it.each([
    ['This is me', `${egret} is your player now.`],
    ['I manage this player', `You manage ${egret}.`],
    ['Remove from my account', `${egret} removed from your account.`],
  ] as const)('closes after %s, confirms it, and Undo brings the player back', async (label, toast) => {
    const page = await Adopt3Page.render('adopted')

    await page.pick(label)
    await page.settle()

    expect(page.dialog).toBeNull()
    expect(page.text).toContain(toast)
    expect(page.reminderTitle).toBeNull()
    expect(document.activeElement).toHaveTextContent('You reviewed every player')

    await page.undo()
    await page.settle()

    expect(page.reminderTitle).toBe('1 player to review')
    expect(page.reviewButton).toHaveFocus()
  })

  it('explains why "This is me" is off when the account has a player', async () => {
    const page = await Adopt3Page.render('has-player')

    expect(page.available('This is me')).toBe(false)
    expect(page.description('This is me')).toBe(
      'You already play as Ama Mensah. We can’t combine two players yet.',
    )
    expect(page.choice('I manage this player')).toHaveFocus()
  })

  it('shows progress, confirms in the dialog, and Undo returns the player', async () => {
    const page = await Adopt3Page.render('two')
    expect(page.dialogText).toContain('Player 1 of 2')

    await page.pick('This is me')
    await page.settle()

    expect(page.dialogTitle).toBe(`Who is ${badger}?`)
    expect(page.dialogText).toContain('Player 2 of 2')
    expect(page.dialogText).toContain(`${egret} is your player now.`)
    expect(page.available('This is me')).toBe(false)
    expect(page.choice('I manage this player')).toHaveFocus()
    expect(page.continueButton).toHaveAttribute('aria-disabled', 'true')

    await page.undo()

    expect(page.dialogTitle).toBe(`Who is ${egret}?`)
    expect(page.available('This is me')).toBe(true)
  })

  it('skips a player without coming back to it, and Home keeps it', async () => {
    const page = await Adopt3Page.render('two')

    await page.skip()
    expect(page.dialogTitle).toBe(`Who is ${badger}?`)
    expect(page.dialogText).not.toContain('Skip this player')

    await page.pick('I manage this player')
    await page.settle()

    expect(page.dialog).toBeNull()
    expect(page.reminderTitle).toBe('1 player to review')
    expect(page.text).toContain(`${egret} was used on this device before you signed in.`)
    expect(page.reviewButton).toHaveTextContent('Review player')
    expect(page.reviewButton).toHaveFocus()
  })

  it('reviews later, keeps every player on Home, and reviews them again', async () => {
    const page = await Adopt3Page.render('two')

    await page.reviewLater()
    await page.settle()

    expect(page.dialog).toBeNull()
    expect(page.reminderTitle).toBe('2 players to review')
    expect(page.reviewButton).toHaveFocus()

    await page.review()
    expect(page.dialogTitle).toBe(`Who is ${egret}?`)
  })

  it('shows only the reminder on a later visit', async () => {
    const page = await Adopt3Page.render('later')

    expect(page.dialog).toBeNull()
    expect(page.reminderTitle).toBe('2 players to review')
    expect(page.text).toContain(
      'These players were used on this device before you signed in. Choose which belong on your account.',
    )

    await page.review()
    expect(page.dialogTitle).toBe(`Who is ${egret}?`)
  })
})
