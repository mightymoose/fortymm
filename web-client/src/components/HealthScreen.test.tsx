import { describe, expect, vi } from 'vitest'
import { loadCore } from '../core/load-core.ts'
import { health } from '../mocks/health.ts'
import { server } from '../mocks/server.ts'
import { it } from '../setupTests.ts'
import { HealthScreenPage } from './HealthScreen.page.tsx'

describe('HealthScreen', () => {
  it('shows its heading', () => {
    const page = HealthScreenPage.render()
    expect(page.heading).toBeInTheDocument()
  })

  describe('API', () => {
    it('says it is checking the server while the request is in flight', () => {
      const page = HealthScreenPage.render()
      expect(page.serverChecking).toBeInTheDocument()
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

    it('shows its core is healthy', async () => {
      const page = HealthScreenPage.render()
      expect(await page.findApiCoreHealthy()).toBeInTheDocument()
    })

    it('shows its core is unhealthy when the api says so', async () => {
      server.use(health.coreUnhealthy())
      const page = HealthScreenPage.render()
      expect(await page.findApiCoreUnhealthy()).toBeInTheDocument()
    })

    it('shows its core is unknown when the api errors', async () => {
      server.use(health.serverError())
      const page = HealthScreenPage.render()
      expect(await page.findApiCoreUnknown()).toBeInTheDocument()
    })
  })

  describe('Web client', () => {
    it('says it is checking the core while it loads', () => {
      const page = HealthScreenPage.render()
      expect(page.webCoreChecking).toBeInTheDocument()
    })

    it('shows its core is healthy', async () => {
      const page = HealthScreenPage.render()
      expect(await page.findWebCoreHealthy()).toBeInTheDocument()
    })

    it('shows its core is unhealthy when it fails to load', async () => {
      vi.mocked(loadCore).mockRejectedValueOnce(new Error('wasm failed to load'))
      const page = HealthScreenPage.render()
      expect(await page.findWebCoreUnhealthy()).toBeInTheDocument()
    })
  })
})
