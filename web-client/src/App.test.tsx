import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { appPage } from './App.page'

describe('App', () => {
  it('renders the FortyMM hero', async () => {
    appPage.render()
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: /play more\.\s*pay never\./i,
      }),
    ).toBeInTheDocument()
  })

  it('exposes the section links behind a mobile hamburger toggle', async () => {
    // Regression for #375: at narrow widths the desktop `.nav-links` are
    // hidden, so the only way to reach Product/Tournaments/Manifesto/FAQ is
    // through a hamburger toggle + collapsible menu. Before the fix neither
    // existed, leaving the nav unreachable on mobile.
    const user = userEvent.setup()
    appPage.render()

    // The toggle is `display:none` on desktop (jsdom applies the stylesheet),
    // so it's hidden from the a11y tree until the mobile breakpoint — query it
    // by its label, which ignores visibility.
    const toggle = await screen.findByLabelText('Open menu')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      document.querySelector('.fortymm-landing .nav-mobile-menu'),
    ).toBeNull()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const menu = document.querySelector('.fortymm-landing .nav-mobile-menu')
    expect(menu).not.toBeNull()
    // The collapsible menu is also stylesheet-hidden in jsdom (no media query),
    // so include hidden elements when asserting its links are present.
    const labels = ['Product', 'Tournaments', 'Manifesto', 'FAQ', 'Sign in']
    for (const label of labels) {
      expect(
        within(menu as HTMLElement).getByRole('link', { name: label, hidden: true }),
      ).toBeInTheDocument()
    }
    expect(
      within(menu as HTMLElement).getByRole('link', {
        name: /start playing/i,
        hidden: true,
      }),
    ).toBeInTheDocument()

    // Tapping a section link collapses the menu again.
    await user.click(
      within(menu as HTMLElement).getByRole('link', {
        name: 'Tournaments',
        hidden: true,
      }),
    )
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      document.querySelector('.fortymm-landing .nav-mobile-menu'),
    ).toBeNull()
  })

  it('switches the active product feature when a tab is clicked', async () => {
    const user = userEvent.setup()
    appPage.render()

    expect(
      await screen.findByRole('heading', { name: /scores in, history out\./i }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /run tournaments/i }))

    expect(
      screen.getByRole('heading', { name: /the schedule, solved\./i }),
    ).toBeInTheDocument()
  })
})

/**
 * The CTA band's store buttons. The iOS one mirrors the sidebar's TestFlight
 * link (`app-shell.test.tsx`): the beta is public, so a logged-out visitor gets
 * the same working link a signed-in user does. Android has no build at all, so
 * it stays inert.
 */
describe('App CTA band', () => {
  it('links to the public TestFlight beta, opening in a new tab', async () => {
    appPage.render()
    await screen.findByRole('heading', {
      level: 1,
      name: /play more\.\s*pay never\./i,
    })

    // A `link` role at all is half the assertion: this was an
    // `aria-disabled` <span> titled "Coming soon", which no role query finds.
    const link = appPage.getIosAppLink()
    expect(link).toHaveAttribute(
      'href',
      'https://testflight.apple.com/join/5pGVbku3',
    )
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).not.toHaveAttribute('aria-disabled')
    // `.btn-disabled` is `pointer-events: none` (landing.css), so the class
    // alone would leave the link unclickable however good its href is.
    expect(link).not.toHaveClass('btn-disabled')
  })

  it('leaves the Android button inert — there is no Android build', async () => {
    appPage.render()
    await screen.findByRole('heading', {
      level: 1,
      name: /play more\.\s*pay never\./i,
    })

    const android = appPage.getAndroidAppCta()
    expect(android).toHaveAttribute('aria-disabled', 'true')
    expect(android).toHaveClass('btn-disabled')
  })
})
