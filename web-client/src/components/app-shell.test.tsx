import userEvent from '@testing-library/user-event'
import { waitFor } from '@/test/utilities'

import { appShellPage } from './app-shell.page'

/**
 * The sidebar's active state. A top-level item owns its whole route subtree
 * (prefix match, guarded by a trailing slash); sub-nav children stay on strict
 * equality so only one child lights at a time.
 *
 * Two layers, asserted separately: the `is-active` / `is-parent-active` classes
 * are what the eye sees, `aria-current="page"` is what a screen reader hears —
 * and they deliberately disagree on a sub-route (#930). See the page object.
 */
describe('AppShell sidebar', () => {
  it('lights Players on a player detail route beneath it', async () => {
    appShellPage.render('/players/u_7')
    await appShellPage.findNavLink('Players')

    expect(appShellPage.getNavLink('Players')).toHaveClass('is-active')
    expect(appShellPage.getActiveNavLabels()).toEqual(['Players'])
  })

  it.each([
    '/matches/new',
    '/matches/m_42',
    '/matches/m_42/results/new',
    '/matches/m_42/games/2/scores/new',
    '/matches/m_42/games/2/scores/edit',
  ])('lights Matches on %s', async (pathname) => {
    appShellPage.render(pathname)
    await appShellPage.findNavLink('Matches')

    expect(appShellPage.getNavLink('Matches')).toHaveClass('is-active')
    expect(appShellPage.getActiveNavLabels()).toEqual(['Matches'])
  })

  it('lights Tournaments on a tournament detail route', async () => {
    appShellPage.render('/tournaments/t_9')
    // Tournaments is permission-gated: it only renders once the session lands.
    await appShellPage.findNavLink('Tournaments')

    expect(appShellPage.getNavLink('Tournaments')).toHaveClass('is-active')
    expect(appShellPage.getActiveNavLabels()).toEqual(['Tournaments'])
  })

  it.each([
    ['/dashboard', 'Dashboard'],
    ['/matches', 'Matches'],
    ['/players', 'Players'],
    ['/tournaments', 'Tournaments'],
  ])('lights %s itself, and only it', async (pathname, label) => {
    appShellPage.render(pathname)
    await appShellPage.findNavLink(label)

    expect(appShellPage.getNavLink(label)).toHaveClass('is-active')
    expect(appShellPage.getActiveNavLabels()).toEqual([label])
  })

  it('does not light Players on a sibling route that merely shares its prefix', async () => {
    appShellPage.render('/players-archive')
    // Wait for the gated items so the whole nav is on screen before asserting
    // nothing in it is active.
    await appShellPage.findNavLink('Tournaments')

    expect(appShellPage.getNavLink('Players')).not.toHaveClass('is-active')
    expect(appShellPage.getActiveNavLabels()).toEqual([])
  })

  it('lights only the Inbox child on the notifications index', async () => {
    appShellPage.render('/notifications')
    await appShellPage.findNavLink('Inbox')

    expect(appShellPage.getActiveSubNavLabels()).toEqual(['Inbox'])
    expect(appShellPage.getActiveNavLabels()).toEqual([])
    expect(appShellPage.getParentActiveNavLabels()).toEqual(['Notifications'])
  })

  it('lights only the Preferences child on the notification settings route, tinting Notifications without activating it', async () => {
    appShellPage.render('/notifications/settings')
    await appShellPage.findNavLink('Preferences')

    // Strict equality for children: Inbox (/notifications) must stay dark even
    // though the pathname sits beneath it.
    expect(appShellPage.getActiveSubNavLabels()).toEqual(['Preferences'])
    expect(appShellPage.getNavLink('Inbox')).not.toHaveClass('is-active')
    // The parent keeps the icon tint only — never the full active class.
    expect(appShellPage.getNavLink('Notifications')).toHaveClass(
      'is-parent-active',
    )
    expect(appShellPage.getNavLink('Notifications')).not.toHaveClass('is-active')
    expect(appShellPage.getParentActiveNavLabels()).toEqual(['Notifications'])
    expect(appShellPage.getActiveNavLabels()).toEqual([])
  })

  it('lights only the Roles child on the admin roles route, tinting Administration without activating it', async () => {
    appShellPage.render('/admin/roles')
    await appShellPage.findNavLink('Roles')

    expect(appShellPage.getActiveSubNavLabels()).toEqual(['Roles'])
    expect(appShellPage.getNavLink('Overview')).not.toHaveClass('is-active')
    expect(appShellPage.getNavLink('Administration')).toHaveClass(
      'is-parent-active',
    )
    expect(appShellPage.getNavLink('Administration')).not.toHaveClass(
      'is-active',
    )
    expect(appShellPage.getParentActiveNavLabels()).toEqual(['Administration'])
    expect(appShellPage.getActiveNavLabels()).toEqual([])
  })

  // #887. The hamburger has always declared `aria-controls="app-shell-sidebar"`,
  // but nothing in the tree carried that id, so the reference dangled. The rest
  // of that fix (a closed drawer being out of the tab order and the a11y tree)
  // is CSS, and so is unprovable here — jsdom has no layout. See
  // `e2e/app-shell.spec.ts` for the assertion that actually pins the behaviour.
  it('points the hamburger aria-controls at a sidebar that exists', async () => {
    appShellPage.render('/dashboard')
    await appShellPage.findNavLink('Dashboard')

    const target = appShellPage.getMenuButton().getAttribute('aria-controls')
    expect(target).toBeTruthy()
    expect(document.getElementById(target!)).toBe(appShellPage.getSidebar())
  })

  /**
   * #930. On `/notifications/settings` the sidebar announced three current
   * pages at once — Notifications, Inbox *and* Preferences (measured in a
   * browser: `["Notifications=page", "Inbox=page", "Preferences=page"]`), because
   * TanStack's `<Link>` marks every prefix match active by default. The visuals
   * were right the whole time; only the accessibility layer lied, telling a
   * screen-reader user they were in the inbox.
   *
   * Every test here asserts BOTH layers. Counting `aria-current` alone would go
   * green on a "fix" that also dimmed the parent highlight — which is the one
   * thing that must not change.
   */
  describe('announces exactly one current page (#930)', () => {
    it('announces only the leaf on the notification settings route, while the parent stays lit', async () => {
      appShellPage.render('/notifications/settings')
      await appShellPage.findNavLink('Preferences')

      // Was ['Notifications=page', 'Inbox=page', 'Preferences=page'].
      // Read by value, not just by count: `aria-current="true"` on the section
      // ancestor would be wrong too — an ancestor announces *nothing*.
      expect(appShellPage.getAriaCurrentValues()).toEqual(['Preferences=page'])
      expect(appShellPage.getCurrentPageNavLabels()).toEqual(['Preferences'])
      expect(appShellPage.getNavLink('Inbox')).not.toHaveAttribute(
        'aria-current',
      )
      expect(appShellPage.getNavLink('Notifications')).not.toHaveAttribute(
        'aria-current',
      )

      // …and the other half of the bargain: the section is still visibly lit.
      expect(appShellPage.getNavLink('Notifications')).toHaveClass(
        'is-parent-active',
      )
      expect(appShellPage.getParentActiveNavLabels()).toEqual(['Notifications'])
      expect(appShellPage.getActiveSubNavLabels()).toEqual(['Preferences'])
    })

    it('announces Inbox — and only Inbox — on the notifications index, while the parent stays lit', async () => {
      appShellPage.render('/notifications')
      await appShellPage.findNavLink('Inbox')

      // The mirror case: here Inbox *is* the leaf. The parent shares the
      // pathname exactly, so this is the one place a prefix match and an exact
      // match could still both fire — they must not.
      expect(appShellPage.getAriaCurrentValues()).toEqual(['Inbox=page'])
      expect(appShellPage.getNavLink('Notifications')).not.toHaveAttribute(
        'aria-current',
      )

      expect(appShellPage.getNavLink('Notifications')).toHaveClass(
        'is-parent-active',
      )
      expect(appShellPage.getActiveSubNavLabels()).toEqual(['Inbox'])
    })

    it('announces only the leaf in the admin section, while Administration stays lit', async () => {
      appShellPage.render('/admin/roles')
      await appShellPage.findNavLink('Roles')

      expect(appShellPage.getAriaCurrentValues()).toEqual(['Roles=page'])
      expect(appShellPage.getNavLink('Overview')).not.toHaveAttribute(
        'aria-current',
      )
      expect(appShellPage.getNavLink('Administration')).toHaveClass(
        'is-parent-active',
      )
    })

    it('announces a childless top-level item on its own route', async () => {
      appShellPage.render('/matches')
      await appShellPage.findNavLink('Matches')

      expect(appShellPage.getAriaCurrentValues()).toEqual(['Matches=page'])
      expect(appShellPage.getActiveNavLabels()).toEqual(['Matches'])
    })

    it('keeps announcing the item when the URL carries search params', async () => {
      // `exact` alone would compare search params *fully* as well, so a link
      // with no search of its own (every link in this sidebar) would stop
      // matching `/matches?page=2` — trading three wrong answers for none.
      // Hence `includeSearch: false`.
      appShellPage.render('/matches?page=2')
      await appShellPage.findNavLink('Matches')

      expect(appShellPage.getAriaCurrentValues()).toEqual(['Matches=page'])
      expect(appShellPage.getActiveNavLabels()).toEqual(['Matches'])
    })

    it('announces nothing on a detail route no nav item points at, but keeps the section lit', async () => {
      appShellPage.render('/players/u_7')
      await appShellPage.findNavLink('Players')

      // Deliberate: you are not *on* the players page, so no link is the
      // current page. Silence is correct; "Players" claiming to be the page you
      // are reading is not. The highlight still tells your eye where you are.
      expect(appShellPage.getAriaCurrentValues()).toEqual([])
      expect(appShellPage.getActiveNavLabels()).toEqual(['Players'])
    })
  })

  it('still tints the parent on a route deeper than any listed child', async () => {
    // No such route exists yet. The point is that when one is added, the
    // section it belongs to stays lit rather than going dark — the very bug
    // this predicate exists to prevent.
    appShellPage.render('/admin/users/u_1')
    await appShellPage.findNavLink('Administration')

    expect(appShellPage.getParentActiveNavLabels()).toEqual(['Administration'])
    // Deeper than "Users", so no child claims the strict-equality highlight.
    expect(appShellPage.getActiveSubNavLabels()).toEqual([])
  })
})

/**
 * The topbar's "Alpha" notice — a **non-modal** Radix popover (the shared
 * `ui/popover.tsx` passes no `modal` prop, so Radix defaults to
 * `modal={false}`).
 *
 * Two different bugs meet here, and only one of them was real:
 *
 * - **#891 — no visible close control.** Measured in a browser: the open panel
 *   contained **zero** buttons. On a 375px viewport it is a 320×272 slab over
 *   most of the page, dismissable only by an outside click or a key a touch user
 *   does not have. The close-control test below is the *discriminating* one — it
 *   fails against the pre-fix shell.
 * - **#885 — "does not close on Escape".** It does. Escape was verified working
 *   in a browser on desktop and mobile before any change was made, and it passes
 *   here both before and after the #891 fix: Radix's `DismissableLayer` handles
 *   it and nothing in the shell intercepts `onEscapeKeyDown`. The Escape test is
 *   therefore a **regression guard**, not a fix — its job is to fail if someone
 *   later adds an `onEscapeKeyDown` preventDefault or a global key handler that
 *   swallows it. It is deliberately non-discriminating today.
 */
/**
 * The TestFlight link pinned to the bottom of the sidebar, below the nav
 * list — a plain external link, not a route the router owns.
 */
describe('AppShell sidebar footer', () => {
  it('links to the public TestFlight beta, opening in a new tab', async () => {
    appShellPage.render('/dashboard')
    await appShellPage.findNavLink('Dashboard')

    const link = appShellPage.getTestFlightLink()
    expect(link).toHaveAttribute(
      'href',
      'https://testflight.apple.com/join/5pGVbku3',
    )
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })
})

describe('AppShell alpha notice', () => {
  it('offers a labelled close control that dismisses it (#891)', async () => {
    appShellPage.render('/dashboard')
    await appShellPage.findNavLink('Dashboard')
    await appShellPage.openAlphaNotice()

    // Before the fix this list was `[]` — the panel had no button at all.
    expect(appShellPage.getAlphaNoticeButtonNames()).toEqual([
      'Close alpha notice',
    ])
    const close = appShellPage.getAlphaCloseButton()
    // Named *and* actually on screen: an sr-only-only affordance would leave a
    // sighted touch user exactly where #891 found them.
    expect(close).toBeVisible()

    await userEvent.click(close)

    await waitFor(() => expect(appShellPage.queryAlphaNotice()).toBeNull())
  })

  it('hands focus back to the Alpha badge once the notice is closed (#891)', async () => {
    appShellPage.render('/dashboard')
    await appShellPage.findNavLink('Dashboard')
    await appShellPage.openAlphaNotice()

    await userEvent.click(appShellPage.getAlphaCloseButton())

    // Dismissing must not strand focus on a detached node — the keyboard user
    // lands back on the control they opened it from.
    await waitFor(() =>
      expect(appShellPage.getAlphaTrigger()).toHaveFocus(),
    )
  })

  it('still dismisses on Escape — regression guard, not a fix (#885)', async () => {
    appShellPage.render('/dashboard')
    await appShellPage.findNavLink('Dashboard')
    await appShellPage.openAlphaNotice()

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(appShellPage.queryAlphaNotice()).toBeNull())
  })
})
