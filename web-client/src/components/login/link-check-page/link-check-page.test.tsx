import { linkCheckPage } from './link-check-page.page'

// A token-shaped string the design prototype used to print. Ryan's design
// feedback was "let's not show the token", and it's a live bearer credential —
// so every state must keep it out of the rendered output.
const TOKEN_PATTERN = /t_[A-Za-z0-9·_-]{6,}/

describe('LinkCheckPage', () => {
  it('checking: spinner disc, checking headline, keep-tab hint, no token', () => {
    linkCheckPage.render({ state: 'checking' })

    expect(linkCheckPage.state()).toBe('checking')
    expect(linkCheckPage.discKind()).toBe('spin')
    expect(linkCheckPage.heading()).toHaveTextContent(/checking your link/i)
    expect(linkCheckPage.text()).toMatch(/keep this tab open/i)
    expect(linkCheckPage.text()).not.toMatch(TOKEN_PATTERN)
  })

  it('success: check disc, success headline, footer action, no token', () => {
    linkCheckPage.render({
      state: 'success',
      footer: <a href="/dashboard">Go to dashboard</a>,
    })

    expect(linkCheckPage.state()).toBe('success')
    expect(linkCheckPage.discKind()).toBe('check')
    expect(linkCheckPage.heading()).toHaveTextContent(/you’re in/i)
    expect(
      linkCheckPage.within().root()?.querySelector('a[href="/dashboard"]'),
    ).toBeTruthy()
    expect(linkCheckPage.text()).not.toMatch(TOKEN_PATTERN)
  })

  it('expired: x disc, error detail surfaced, footer action, no token', () => {
    linkCheckPage.render({
      state: 'expired',
      detail: 'That confirmation link is invalid or expired.',
      footer: <a href="/login">Send a new link</a>,
    })

    expect(linkCheckPage.state()).toBe('expired')
    expect(linkCheckPage.discKind()).toBe('x')
    expect(linkCheckPage.text()).toMatch(/invalid or expired/i)
    expect(
      linkCheckPage.within().root()?.querySelector('a[href="/login"]'),
    ).toBeTruthy()
    expect(linkCheckPage.text()).not.toMatch(TOKEN_PATTERN)
  })

  it('lets the route override the default copy', () => {
    linkCheckPage.render({
      state: 'checking',
      eyebrow: '● Confirming your email',
      title: 'Confirming your email',
      subtitle: 'One moment.',
    })

    expect(linkCheckPage.heading()).toHaveTextContent(/confirming your email/i)
    expect(linkCheckPage.text()).toMatch(/one moment/i)
  })
})
