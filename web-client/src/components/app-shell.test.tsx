import { appShellPage } from './app-shell.page'

/**
 * The sidebar's active state. A top-level item owns its whole route subtree
 * (prefix match, guarded by a trailing slash); sub-nav children stay on strict
 * equality so only one child lights at a time.
 *
 * Assertions read the `is-active` / `is-parent-active` classes — see the page
 * object for why `aria-current` (which TanStack's `<Link>` stamps on every
 * prefix match of its own accord) can't stand in for them.
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
