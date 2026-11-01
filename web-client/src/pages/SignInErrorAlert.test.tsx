import { cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { HomePage } from '../test/pages/HomePage'

describe('SignInErrorAlert', () => {
  it.each([
    ['cancelled', 'status', 'Sign-in cancelled', 'You didn’t finish signing in, so nothing changed.'],
    [
      'email_not_verified',
      'alert',
      'Verify your email first',
      'Your sign-in provider hasn’t verified this email address. Verify it with them, then try again.',
    ],
    ['expired', 'alert', 'Sign-in took too long', 'A sign-in has 10 minutes to finish. Start again.'],
    [
      'failed',
      'alert',
      'Sign-in didn’t work',
      'Something went wrong, and nothing changed. Try again.',
    ],
    [
      'used',
      'status',
      'Sign-in already finished',
      'That sign-in already finished. If you’re not signed in, sign in again.',
    ],
    [
      'something_new',
      'alert',
      'Sign-in didn’t work',
      'Something went wrong, and nothing changed. Try again.',
    ],
  ])('explains sign_in_error=%s as a %s', async (code, role, title, body) => {
    const homePage = await HomePage.render({ path: `/?sign_in_error=${code}` })

    const message = homePage.signInMessage(title)
    expect(message).toHaveAttribute('role', role)
    expect(message).toHaveTextContent(`${title}${body}`)
  })

  it('removes the code from the URL, so a reload shows no message', async () => {
    const homePage = await HomePage.render({ path: '/?tab=leagues&sign_in_error=expired' })
    const message = homePage.signInMessage('Sign-in took too long')!

    await waitFor(() => expect(homePage.href).toBe('/?tab=leagues'))
    expect(message).toBeInTheDocument()
    expect(homePage.tryAgainLink(message)).toHaveAttribute(
      'href',
      '/api/v1/auth/login?return_to=%2F%3Ftab%3Dleagues',
    )

    const cleaned = homePage.href
    cleanup()
    const reloaded = await HomePage.render({ path: cleaned })
    expect(reloaded.title).toBeInTheDocument()
    expect(reloaded.signInMessage('Sign-in took too long')).not.toBeInTheDocument()
  })

  it('hides the message when dismissed', async () => {
    const homePage = await HomePage.render({ path: '/?sign_in_error=failed' })

    await userEvent.click(homePage.dismissButton(homePage.signInMessage('Sign-in didn’t work')!))

    expect(homePage.signInMessage('Sign-in didn’t work')).not.toBeInTheDocument()
  })

  it('shows no message without a code', async () => {
    const homePage = await HomePage.render({ path: '/?tab=leagues' })

    expect(homePage.title).toBeInTheDocument()
    expect(homePage.signInMessage('Sign-in didn’t work')).not.toBeInTheDocument()
    expect(homePage.href).toBe('/?tab=leagues')
  })
})
