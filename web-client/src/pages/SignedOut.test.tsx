import { describe, expect, it } from 'vitest'
import { SignedOutPage } from '../test/pages/SignedOutPage'
import { server } from '../test/server'

describe('SignedOut', () => {
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

  it('signs in back to Home, or plays as a guest on Home', async () => {
    const signedOutPage = await SignedOutPage.render()

    expect(signedOutPage.signInLink).toHaveAttribute(
      'href',
      '/api/v1/auth/login?return_to=%2F',
    )
    expect(signedOutPage.guestLink).toHaveAttribute('href', '/')
  })
})
