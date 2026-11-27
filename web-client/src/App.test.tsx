import { describe, expect } from 'vitest'
import { AppPage } from './App.page.tsx'
import { it } from './setupTests.ts'

describe('App', () => {
  it('shows the home screen at /', async () => {
    const app = await AppPage.render('/')
    expect(app.home.heading).toBeInTheDocument()
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
    expect(await app.home.findHeading()).toBeInTheDocument()
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
