import { describe, expect } from 'vitest'
import { AppPage } from './App.page.tsx'
import { it } from './setupTests.ts'

describe('App', () => {
  it('shows the dashboard at /', async () => {
    const app = await AppPage.render('/')
    expect(app.dashboard.heading).toBeInTheDocument()
  })

  it('shows the matches list at /matches', async () => {
    const app = await AppPage.render('/matches')
    expect(app.matches.heading).toBeInTheDocument()
  })

  it('shows the new match screen at /matches/new', async () => {
    const app = await AppPage.render('/matches/new')
    expect(app.newMatch.heading).toBeInTheDocument()
  })

  it('shows the user list at /users', async () => {
    const app = await AppPage.render('/users')
    expect(app.users.heading).toBeInTheDocument()
  })

  it('shows the admin screen at /admin', async () => {
    const app = await AppPage.render('/admin')
    expect(app.admin.heading).toBeInTheDocument()
  })

  it('shows the settings screen at /settings', async () => {
    const app = await AppPage.render('/settings')
    expect(app.settings.heading).toBeInTheDocument()
  })

  describe('layout', () => {
    it('shows a screen inside the layout’s <main>', async () => {
      const app = await AppPage.render('/matches')
      expect(await app.layout.findMain()).toContainElement(app.matches.heading)
    })

    it('collapses the sidebar from the top bar’s toggle', async ({ user }) => {
      const app = await AppPage.render('/')
      await user.click(await app.layout.findSidebarToggle())
      expect(await app.layout.findSidebarToggle()).toHaveAttribute('aria-expanded', 'false')
    })

    it('expands the sidebar again from the toggle', async ({ user }) => {
      const app = await AppPage.render('/')
      await user.click(await app.layout.findSidebarToggle())
      await user.click(await app.layout.findSidebarToggle())
      expect(await app.layout.findSidebarToggle()).toHaveAttribute('aria-expanded', 'true')
    })

    it('keeps the sidebar collapsed from page to page', async ({ user }) => {
      const app = await AppPage.render('/')
      await user.click(await app.layout.findSidebarToggle())
      await user.click(await app.layout.findSidebarLink('Users'))
      await app.users.findHeading()
      expect(await app.layout.findSidebarToggle()).toHaveAttribute('aria-expanded', 'false')
    })

    it.for([
      { name: 'Matches', screen: 'matches' },
      { name: 'Users', screen: 'users' },
      { name: 'Admin', screen: 'admin' },
      { name: 'Settings', screen: 'settings' },
    ] as const)('goes to $name from the sidebar', async ({ name, screen }, { user }) => {
      const app = await AppPage.render('/')
      await user.click(await app.layout.findSidebarLink(name))
      expect(await app[screen].findHeading()).toBeInTheDocument()
    })

    it('goes to the dashboard from the sidebar', async ({ user }) => {
      const app = await AppPage.render('/settings')
      await user.click(await app.layout.findSidebarLink('Dashboard'))
      expect(await app.dashboard.findHeading()).toBeInTheDocument()
    })

    it('goes to the dashboard from the top bar’s brand', async ({ user }) => {
      const app = await AppPage.render('/settings')
      await user.click(await app.layout.findBrand())
      expect(await app.dashboard.findHeading()).toBeInTheDocument()
    })

    it('goes to the new match screen from the bottom bar', async ({ user }) => {
      const app = await AppPage.render('/')
      await user.click(await app.layout.findBottomBarLink('New match'))
      expect(await app.newMatch.findHeading()).toBeInTheDocument()
    })

    it('leaves the design system boards out of the layout', async () => {
      const app = await AppPage.render('/design-system')
      expect(app.layout.sidebar()).toBeNull()
    })

    it('leaves the health screen out of the layout', async () => {
      const app = await AppPage.render('/health')
      expect(app.layout.sidebar()).toBeNull()
    })
  })

  it('shows the health screen at /health', async () => {
    const app = await AppPage.render('/health')
    expect(app.health.heading).toBeInTheDocument()
  })

  it('shows the not-found screen at an unknown path', async () => {
    const app = await AppPage.render('/no-such-page')
    expect(app.notFound.heading).toBeInTheDocument()
  })

  it('goes home from the not-found screen', async ({ user }) => {
    const app = await AppPage.render('/no-such-page')
    await user.click(app.notFound.homeLink)
    expect(await app.dashboard.findHeading()).toBeInTheDocument()
  })

  describe('design system', () => {
    it('shows the showcase title at /design-system', async () => {
      const app = await AppPage.render('/design-system')
      expect(app.designSystem.main.heading).toBeInTheDocument()
    })

    it('shows Foundations at /design-system', async () => {
      const app = await AppPage.render('/design-system')
      expect(app.designSystem.main.foundationsHeading).toBeInTheDocument()
    })

    it('shows Roles at a glance at /design-system/roles', async () => {
      const app = await AppPage.render('/design-system/roles')
      expect(app.designSystem.roles.rolesAtAGlanceHeading).toBeInTheDocument()
    })

    it('shows Buttons at /design-system/roles', async () => {
      const app = await AppPage.render('/design-system/roles')
      expect(app.designSystem.roles.buttonsHeading).toBeInTheDocument()
    })

    it('goes to the Match board from View draw on the Roles board', async ({ user }) => {
      const app = await AppPage.render('/design-system/roles')
      await user.click(app.designSystem.roles.viewDrawLink)
      expect(await app.designSystem.match.findMatchComponentsHeading()).toBeInTheDocument()
    })

    it('shows Fields and choices at /design-system/forms', async () => {
      const app = await AppPage.render('/design-system/forms')
      expect(app.designSystem.forms.fieldsAndChoicesHeading).toBeInTheDocument()
    })

    it('shows Selection at /design-system/forms', async () => {
      const app = await AppPage.render('/design-system/forms')
      expect(app.designSystem.forms.selectionHeading).toBeInTheDocument()
    })

    it('shows Containers at /design-system/containers', async () => {
      const app = await AppPage.render('/design-system/containers')
      expect(app.designSystem.containers.containersHeading).toBeInTheDocument()
    })

    it('shows Feedback at /design-system/containers', async () => {
      const app = await AppPage.render('/design-system/containers')
      expect(app.designSystem.containers.feedbackHeading).toBeInTheDocument()
    })

    it('shows Overlays at /design-system/overlays', async () => {
      const app = await AppPage.render('/design-system/overlays')
      expect(app.designSystem.overlays.overlaysHeading).toBeInTheDocument()
    })

    it('shows Match components at /design-system/match', async () => {
      const app = await AppPage.render('/design-system/match')
      expect(app.designSystem.match.matchComponentsHeading).toBeInTheDocument()
    })

    it('shows More components at /design-system/more', async () => {
      const app = await AppPage.render('/design-system/more')
      expect(app.designSystem.more.moreComponentsHeading).toBeInTheDocument()
    })

    it('shows State matrix at /design-system/states', async () => {
      const app = await AppPage.render('/design-system/states')
      expect(app.designSystem.states.stateMatrixHeading).toBeInTheDocument()
    })
  })
})
