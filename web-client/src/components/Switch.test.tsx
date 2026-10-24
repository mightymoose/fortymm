import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Switch } from './Switch'

describe('Switch', () => {
  it('turns over on a click or Space, and says its new state', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Switch onChange={onChange}>Show ratings to spectators</Switch>)
    const toggle = screen.getByRole('switch', { name: 'Show ratings to spectators' })
    expect(toggle).not.toBeChecked()

    await user.click(toggle)
    expect(toggle).toBeChecked()
    expect(onChange).toHaveBeenLastCalledWith(true)

    await user.keyboard(' ')
    expect(toggle).not.toBeChecked()
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('starts on with defaultChecked', () => {
    render(<Switch defaultChecked>Call players automatically</Switch>)

    expect(screen.getByRole('switch', { name: 'Call players automatically' })).toBeChecked()
  })

  it('ignores clicks while disabled', async () => {
    const user = userEvent.setup()
    render(<Switch disabled>Text players (needs phone numbers)</Switch>)
    const toggle = screen.getByRole('switch', { name: 'Text players (needs phone numbers)' })

    await user.click(toggle)

    expect(toggle).not.toBeChecked()
  })
})
