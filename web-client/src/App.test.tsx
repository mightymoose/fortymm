import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App', () => {
  it('renders the FortyMM hero', () => {
    render(<App />)
    expect(
      screen.getByRole('heading', { level: 1, name: /play more\.\s*pay never\./i }),
    ).toBeInTheDocument()
  })

  it('switches the active product feature when a tab is clicked', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(
      screen.getByRole('heading', { name: /scores in, history out\./i }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /run tournaments/i }))

    expect(
      screen.getByRole('heading', { name: /the schedule, solved\./i }),
    ).toBeInTheDocument()
  })
})
