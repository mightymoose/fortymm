import { describe, expect } from 'vitest'
import { health } from '../mocks/health.ts'
import { server } from '../mocks/server.ts'
import { it } from '../setupTests.ts'
import { HealthScreenPage } from './HealthScreen.page.tsx'

describe('HealthScreen', () => {
  it('shows its heading', () => {
    const page = HealthScreenPage.render()
    expect(page.heading).toBeInTheDocument()
  })

  it('says it is checking while the request is in flight', () => {
    const page = HealthScreenPage.render()
    expect(page.checking).toBeInTheDocument()
  })

  it('shows the server is ok', async () => {
    const page = HealthScreenPage.render()
    expect(await page.findServerOk()).toBeInTheDocument()
  })

  it('shows the server is unreachable when the api errors', async () => {
    server.use(health.serverError())
    const page = HealthScreenPage.render()
    expect(await page.findServerUnreachable()).toBeInTheDocument()
  })

  it('shows the server is unreachable when the response is malformed', async () => {
    server.use(health.malformed())
    const page = HealthScreenPage.render()
    expect(await page.findServerUnreachable()).toBeInTheDocument()
  })
})
