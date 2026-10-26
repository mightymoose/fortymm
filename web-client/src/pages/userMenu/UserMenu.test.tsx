import { within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../../api/schema'
import { leavePage } from '../../leavePage'
import { HomePage } from '../../test/pages/HomePage'
import { API_BASE_URL, logoutResponse, server, sessionResponse } from '../../test/server'

vi.mock('../../leavePage', () => ({ leavePage: vi.fn() }))

const ann: components['schemas']['SessionResponse'] = {
  data: {
    account: { ...sessionResponse.data.account, kind: 'verified', email: 'ann@example.com' },
  },
}

function signInAs(response: components['schemas']['SessionResponse']) {
  server.use(http.post(`${API_BASE_URL}/v1/session`, () => HttpResponse.json(response)))
}

function menuItem(homePage: HomePage, name: string): HTMLElement {
  return within(homePage.accountMenu).getByRole('menuitem', { name })
}

describe('UserMenu', () => {
  afterEach(() => {
    vi.mocked(leavePage).mockReset()
  })

  it('shows the player as a chip, which opens the menu, and Esc closes it back to the chip', async () => {
    const homePage = await HomePage.render()
    const button = homePage.accountButton!

    expect(button).toHaveTextContent('EEexcited egret 387')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(menuItem(homePage, 'Sign in')).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveFocus()
  })

  it('offers a guest Sign in, which brings them back to this page', async () => {
    const homePage = await HomePage.render({ path: '/?from=menu' })

    await userEvent.click(homePage.accountButton!)

    expect(homePage.accountMenu).toHaveTextContent('Playing as a guest')
    expect(menuItem(homePage, 'Sign in')).toHaveAttribute(
      'href',
      `/api/v1/auth/login?return_to=${encodeURIComponent('/?from=menu')}`,
    )
  })

  it('asks a guest before it signs out, and offers Sign in there', async () => {
    const homePage = await HomePage.render()

    await userEvent.click(homePage.accountButton!)
    await userEvent.click(menuItem(homePage, 'Sign out'))

    const dialog = homePage.guestSignOutDialog
    expect(homePage.accountButton).toHaveAttribute('aria-expanded', 'false')
    expect(dialog).toHaveTextContent('you can’t get it back, and excited egret 387 stays behind')
    expect(within(dialog).getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/api/v1/auth/login?return_to=%2F',
    )
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep playing' }))
    expect(dialog).not.toBeVisible()
    expect(homePage.accountButton).toHaveFocus()
    expect(leavePage).not.toHaveBeenCalled()

    await userEvent.click(homePage.accountButton!)
    await userEvent.click(menuItem(homePage, 'Sign out'))
    await userEvent.click(within(homePage.guestSignOutDialog).getByRole('button', { name: 'Sign out' }))

    await vi.waitFor(() =>
      expect(leavePage).toHaveBeenCalledExactlyOnceWith(logoutResponse.data.logout_url),
    )
  })

  it('signs a verified account out at once, with no dialog', async () => {
    signInAs(ann)
    const homePage = await HomePage.render()

    await userEvent.click(homePage.accountButton!)
    expect(homePage.accountMenu).toHaveTextContent('ann@example.com')
    expect(within(homePage.accountMenu).queryByRole('menuitem', { name: 'Sign in' })).toBeNull()
    await userEvent.click(menuItem(homePage, 'Sign out'))

    await vi.waitFor(() =>
      expect(leavePage).toHaveBeenCalledExactlyOnceWith(logoutResponse.data.logout_url),
    )
  })

  it('says when signing out failed, and keeps the menu open', async () => {
    signInAs(ann)
    server.use(http.post(`${API_BASE_URL}/v1/auth/logout`, () => HttpResponse.error()))
    const homePage = await HomePage.render()

    await userEvent.click(homePage.accountButton!)
    await userEvent.click(menuItem(homePage, 'Sign out'))

    expect(await within(homePage.accountMenu).findByRole('alert')).toHaveTextContent(
      'Couldn’t sign you out.',
    )
    expect(leavePage).not.toHaveBeenCalled()
  })
})
