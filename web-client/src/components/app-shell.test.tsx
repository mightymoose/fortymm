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
