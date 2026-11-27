import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { createTestQueryClient } from '../testQueryClient.ts'
import { HealthScreen } from './HealthScreen.tsx'

// Page object for the health screen. Use `render()` to test it on its own, or construct one after
// rendering the whole app (see App.page.tsx). The api is MSW's (see src/mocks/), the core is
// src/core/__mocks__/load-core.ts.
export class HealthScreenPage {
  static render() {
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <HealthScreen />
      </QueryClientProvider>,
    )
    return new HealthScreenPage()
  }

  get heading() {
    return screen.getByRole('heading', { level: 1, name: 'Health' })
  }

  // Both sides show a Core line, so each is looked up within its own section.
  private get api() {
    return within(screen.getByRole('region', { name: 'API' }))
  }

  private get webClient() {
    return within(screen.getByRole('region', { name: 'Web client' }))
  }

  get serverChecking() {
    return this.api.getByText('Server: checking…')
  }

  get webCoreChecking() {
    return this.webClient.getByText('Core: checking…')
  }

  // These wait for the check to finish.
  findServerOk() {
    return this.api.findByText('Server: ok')
  }

  findServerUnreachable() {
    return this.api.findByText('Server: unreachable')
  }

  findApiCoreHealthy() {
    return this.api.findByText('Core: healthy')
  }

  findApiCoreUnhealthy() {
    return this.api.findByText('Core: unhealthy')
  }

  findApiCoreUnknown() {
    return this.api.findByText('Core: unknown')
  }

  findWebCoreHealthy() {
    return this.webClient.findByText('Core: healthy')
  }

  findWebCoreUnhealthy() {
    return this.webClient.findByText('Core: unhealthy')
  }
}
