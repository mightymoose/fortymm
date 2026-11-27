import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { createTestQueryClient } from '../testQueryClient.ts'
import { HealthScreen } from './HealthScreen.tsx'

// Page object for the health screen. Use `render()` to test it on its own, or construct one after
// rendering the whole app (see App.page.tsx). The api is MSW's (see src/mocks/).
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

  get checking() {
    return screen.getByText('Checking…')
  }

  // These wait for the health check to finish.
  findServerOk() {
    return screen.findByText('Server: ok')
  }

  findServerUnreachable() {
    return screen.findByText('Server: unreachable')
  }
}
