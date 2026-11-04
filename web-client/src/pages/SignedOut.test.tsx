import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SignedOutPage } from '../test/pages/SignedOutPage'
import { API_BASE_URL, server } from '../test/server'

describe('SignedOut', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('says the visitor is signed out, without starting a session', async () => {
    const requests: string[] = []
    const record = ({ request }: { request: Request }) => void requests.push(request.url)
    server.events.on('request:start', record)
    const signedOutPage = await SignedOutPage.render()
    server.events.removeListener('request:start', record)

    expect(signedOutPage.title).toHaveTextContent('You’re signed out')
    expect(signedOutPage.sidebar).toBeNull()
    expect(requests).toEqual([])
  })

  it('starts no session when the visitor points at or focuses Play as a guest, only on a click', async () => {
    const requests: string[] = []
    const record = ({ request }: { request: Request }) => void requests.push(request.url)
    server.events.on('request:start', record)
    const signedOutPage = await SignedOutPage.render()

    fireEvent.mouseEnter(signedOutPage.guestLink)
    fireEvent.focus(signedOutPage.guestLink)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(requests).toEqual([])

    fireEvent.click(signedOutPage.guestLink)
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument()
    await waitFor(() =>
      expect(requests).toEqual([
        `${API_BASE_URL}/v1/session`,
        `${API_BASE_URL}/v1/account/signing-keys`,
      ]),
    )
    server.events.removeListener('request:start', record)
  })

  it('signs in back to Home, or plays as a guest on Home', async () => {
    const signedOutPage = await SignedOutPage.render()

    expect(signedOutPage.signInLink).toHaveAttribute(
      'href',
      '/api/v1/auth/login?return_to=%2F',
    )
    expect(signedOutPage.guestLink).toHaveAttribute('href', '/')
  })

  it('explains a rate-limited sign-in with the time to try again, without starting a session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-01T10:41:30'))
    const requests: string[] = []
    const record = ({ request }: { request: Request }) => void requests.push(request.url)
    server.events.on('request:start', record)
    const signedOutPage = await SignedOutPage.render({
      path: '/signed-out?sign_in_error=rate_limited&retry_after=60',
    })
    server.events.removeListener('request:start', record)

    const message = signedOutPage.signInMessage('Too many sign-ins from this network')!
    expect(message).toHaveAttribute('role', 'alert')
    expect(message).toHaveTextContent(
      'Many people on this network are signing in at once. Wait a minute, then try again.',
    )
    const at = new Date('2026-11-01T10:42:30').toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
    expect(signedOutPage.retryTime(message)).toHaveTextContent(`Try again at ${at}`)
    expect(signedOutPage.tryAgainLink(message)).toHaveAttribute(
      'href',
      '/api/v1/auth/login?return_to=%2F',
    )
    expect(signedOutPage.title).toHaveTextContent('You’re signed out')
    expect(requests).toEqual([])

    await waitFor(() => expect(signedOutPage.href).toBe('/signed-out'))
    expect(message).toBeInTheDocument()

    cleanup()
    const reloaded = await SignedOutPage.render({ path: signedOutPage.href })
    expect(reloaded.signInMessage('Too many sign-ins from this network')).not.toBeInTheDocument()
  })

  it.each(['', '&retry_after=soon', '&retry_after=-5'])(
    'explains a rate-limited sign-in without a time when retry_after is %j',
    async (retryAfter) => {
      const signedOutPage = await SignedOutPage.render({
        path: `/signed-out?sign_in_error=rate_limited${retryAfter}`,
      })

      const message = signedOutPage.signInMessage('Too many sign-ins from this network')!
      expect(message).toBeInTheDocument()
      expect(signedOutPage.retryTime(message)).not.toBeInTheDocument()
      await waitFor(() => expect(signedOutPage.href).toBe('/signed-out'))
    },
  )

  it('shows no message without a code', async () => {
    const signedOutPage = await SignedOutPage.render()

    expect(signedOutPage.signInMessage('Sign-in didn’t work')).not.toBeInTheDocument()
    expect(signedOutPage.href).toBe('/signed-out')
  })
})
