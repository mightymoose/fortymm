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
    // Support escape hatch is always present on the expired state.
    expect(
      linkCheckPage
        .within()
        .root()
        ?.querySelector('a[href="mailto:support@fortymm.com"]'),
    ).toBeTruthy()
    expect(linkCheckPage.text()).not.toMatch(TOKEN_PATTERN)
  })

  it('missing: distinct incomplete-link copy, not the expired wording, with support escape hatch', () => {
    linkCheckPage.render({
      state: 'missing',
      footer: <a href="/login">Send a new link</a>,
    })

    expect(linkCheckPage.state()).toBe('missing')
    expect(linkCheckPage.heading()).toHaveTextContent(/this link is incomplete/i)
    expect(linkCheckPage.text()).toMatch(/missing its token/i)
    expect(linkCheckPage.text()).not.toMatch(/can’t be used|can't be used/i)
    expect(
      linkCheckPage
        .within()
        .root()
        ?.querySelector('a[href="mailto:support@fortymm.com"]'),
    ).toBeTruthy()
    expect(linkCheckPage.text()).not.toMatch(TOKEN_PATTERN)
  })

  it('replaced: distinct copy from expired, no token, support escape hatch (#1466 defect 3)', () => {
    linkCheckPage.render({
      state: 'replaced',
      footer: <button type="button">Send a new link instead</button>,
    })

    expect(linkCheckPage.state()).toBe('replaced')
    expect(linkCheckPage.heading()).toHaveTextContent(/newer link/i)
    expect(linkCheckPage.text()).toMatch(/most recent email|newer sign-in link/i)
    // Must not say "expired" — this link is dead for a different, true reason.
    expect(linkCheckPage.text()).not.toMatch(/15 minutes|already used/i)
    expect(
      linkCheckPage
        .within()
        .root()
        ?.querySelector('a[href="mailto:support@fortymm.com"]'),
    ).toBeTruthy()
    expect(linkCheckPage.text()).not.toMatch(TOKEN_PATTERN)
  })

  it('email_changed: distinct copy from expired, no token (#1466 defect 3)', () => {
    linkCheckPage.render({
      state: 'email_changed',
      footer: <a href="/login">Send a new link</a>,
    })

    expect(linkCheckPage.state()).toBe('email_changed')
    expect(linkCheckPage.text()).toMatch(/email.*changed|no longer matches/i)
    expect(linkCheckPage.text()).not.toMatch(/15 minutes|already used/i)
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
