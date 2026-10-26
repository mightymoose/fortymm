import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../../api/schema'
import { leavePage } from '../../leavePage'
import { HomePage } from '../../test/pages/HomePage'
import { API_BASE_URL, logoutResponse, server, sessionResponse } from '../../test/server'
import { userMenuDesigns, type UserMenuDesign } from './userMenuDesigns'

vi.mock('../../leavePage', () => ({ leavePage: vi.fn() }))

const ann: components['schemas']['SessionResponse'] = {
  data: {
    account: { ...sessionResponse.data.account, kind: 'verified', email: 'ann@example.com' },
  },
}

function signInAs(response: components['schemas']['SessionResponse']) {
  server.use(http.post(`${API_BASE_URL}/v1/session`, () => HttpResponse.json(response)))
}

// The card and the sheet hold a link and a button. The others are menus.
const isMenu = (design: UserMenuDesign) => design !== 'card' && design !== 'sheet'

// The open menu, card or sheet of `design`.
function openedPanel(homePage: HomePage, design: UserMenuDesign): HTMLElement {
  if (design === 'card') return homePage.accountPanel('excited egret 387')
  if (design === 'sheet') return homePage.accountPanel('Your account')
  return homePage.accountMenu
}

describe('UserMenu', () => {
  afterEach(() => {
    vi.mocked(leavePage).mockReset()
  })

  it('opens from the avatar, and Esc closes it back to the avatar', async () => {
    const homePage = await HomePage.render()
    const button = homePage.accountButton!

    expect(button).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(homePage.accountMenu).toHaveTextContent('excited egret 387')
    expect(within(homePage.accountMenu).getByRole('menuitem', { name: 'Sign in' })).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveFocus()
  })

  describe.each(userMenuDesigns)('the %s design', (design) => {
    it('offers a guest Sign in, which brings them back to this page', async () => {
      const homePage = await HomePage.render({ path: `/?menu=${design}` })

      await userEvent.click(homePage.accountButton!)

      const panel = openedPanel(homePage, design)
      expect(panel).toHaveTextContent('Playing as a guest')
      const signIn = within(panel).getByRole(isMenu(design) ? 'menuitem' : 'link', {
        name: 'Sign in',
      })
      expect(signIn).toHaveAttribute(
        'href',
        `/api/v1/auth/login?return_to=${encodeURIComponent(`/?menu=${design}`)}`,
      )
    })

    it("signs a verified account out to the identity provider's logout page", async () => {
      signInAs(ann)
      const homePage = await HomePage.render({ path: `/?menu=${design}` })

      await userEvent.click(homePage.accountButton!)
      const panel = openedPanel(homePage, design)
      expect(panel).toHaveTextContent('ann@example.com')
      await userEvent.click(
        within(panel).getByRole(isMenu(design) ? 'menuitem' : 'button', { name: 'Sign out' }),
      )
      if (design === 'confirm') {
        const dialog = screen.getByRole('dialog', { name: 'Sign out of FortyMM?' })
        await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }))
      }

      await vi.waitFor(() =>
        expect(leavePage).toHaveBeenCalledExactlyOnceWith(logoutResponse.data.logout_url),
      )
    })
  })

  it('names a verified account with no player by its email', async () => {
    signInAs({ data: { account: { ...ann.data.account, player: null } } })
    const homePage = await HomePage.render()

    expect(homePage.avatar('ann@example.com')).toHaveTextContent(/^A$/)
  })

  it('says when signing out failed, and keeps the menu open', async () => {
    signInAs(ann)
    server.use(http.post(`${API_BASE_URL}/v1/auth/logout`, () => HttpResponse.error()))
    const homePage = await HomePage.render()

    await userEvent.click(homePage.accountButton!)
    await userEvent.click(within(homePage.accountMenu).getByRole('menuitem', { name: 'Sign out' }))

    expect(await within(homePage.accountMenu).findByRole('alert')).toHaveTextContent(
      'Couldn’t sign you out.',
    )
    expect(leavePage).not.toHaveBeenCalled()
  })
})
