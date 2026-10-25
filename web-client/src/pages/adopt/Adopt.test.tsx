import { describe, expect, it } from 'vitest'
import { AdoptPage, type AdoptPath } from '../../test/pages/AdoptPage'

const egret = 'excited egret 387'
const badger = 'brave badger 214'

describe.each<AdoptPath>(['/adopt1', '/adopt2'])('%s', (path) => {
  it('says which players moved to the account', async () => {
    const page = await AdoptPage.render(path, 'adopted')

    expect(page.text).toContain(`We added ${egret} to your account.`)
    expect(await page.question(egret)).not.toBeNull()
  })

  it('says nothing moved after a first sign-in with a new email', async () => {
    const page = await AdoptPage.render(path, 'new-email')

    expect(page.text).toContain('Your games on this device stay with you.')
    expect(page.text).not.toContain('We added')
    expect(await page.question(egret)).not.toBeNull()
  })

  it('explains each answer before it is picked', async () => {
    const page = await AdoptPage.render(path, 'adopted')
    await page.question(egret)

    expect(page.text).toContain(`${egret} becomes your player.`)
    expect(page.text).toContain(`${egret} stays on your account as a player you manage`)
    expect(page.text).toContain(`We take ${egret} off your account.`)
  })

  it.each([
    ['Yes', `${egret} is your player now.`],
    ['No, it is someone else', `${egret} stays on your account as a player you manage.`],
    ['Not mine', `We took ${egret} off your account.`],
  ] as const)('answers %s and stops asking', async (label, result) => {
    const page = await AdoptPage.render(path, 'adopted')

    await page.answer(egret, label)

    expect(page.text).toContain(result)
    expect(await page.question(egret)).toBeNull()
  })

  it('turns off "Yes" while the account has its own player', async () => {
    const page = await AdoptPage.render(path, 'has-player')

    expect(await page.yesAvailable(egret)).toBe(false)
    expect(page.text).toContain('You already play as Ama Mensah.')
  })

  it('turns off "Yes" for the next player once one is the account’s own', async () => {
    const page = await AdoptPage.render(path, 'two')
    expect(await page.yesAvailable(egret)).toBe(true)

    await page.answer(egret, 'Yes')

    expect(await page.yesAvailable(badger)).toBe(false)
  })

  it('keeps asking on a later visit to Home, with no sign-in notice', async () => {
    const page = await AdoptPage.render(path, 'later')

    expect(page.text).not.toContain('You’re signed in')
    expect(await page.question(egret)).not.toBeNull()
    expect(page.text).toContain('What’s coming, and when.')
  })
})
