import { describe, expect, it } from 'vitest'
import { SignInStoppedPage } from '../test/pages/SignInStoppedPage'
import { server } from '../test/server'

describe('SignInStopped', () => {
  it('says the sign-in stopped, without starting a session', async () => {
    const requests: string[] = []
    const record = ({ request }: { request: Request }) => void requests.push(request.url)
    server.events.on('request:start', record)
    const signInStoppedPage = await SignInStoppedPage.render(
      '/sign-in-stopped?error=invalid_request&error_description=x&tracking=y',
    )
    server.events.removeListener('request:start', record)

    expect(signInStoppedPage.title).toHaveTextContent('Sign-in stopped here')
    expect(signInStoppedPage.sidebar).toBeNull()
    expect(requests).toEqual([])
  })

  it('goes to Home, or signs in again back to Home', async () => {
    const signInStoppedPage = await SignInStoppedPage.render()

    expect(signInStoppedPage.homeLink).toHaveAttribute('href', '/')
    expect(signInStoppedPage.signInLink).toHaveAttribute(
      'href',
      '/api/v1/auth/login?return_to=%2F',
    )
  })
})
