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
})
