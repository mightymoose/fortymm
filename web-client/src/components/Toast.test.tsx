import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Toast } from './Toast'

describe('Toast', () => {
  it('is a status named by its title, over its description', () => {
    render(
      <Toast
        variant="success"
        title="Match logged"
        description="Rating: 1620 (+18)"
        onDismiss={() => {}}
      />,
    )

    const toast = screen.getByRole('status', { name: 'Match logged' })
    expect(toast).toHaveTextContent('Match loggedRating: 1620 (+18)')
    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent(
      'Match logged',
    )
  })

  it('calls onDismiss when its close button is clicked', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(
      <Toast
        variant="info"
        title="Reminder"
        description="You're up next on Court 3."
        onDismiss={onDismiss}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Dismiss "Reminder"' }))

    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('gives each close button its own name', () => {
    render(
      <>
        <Toast variant="info" title="One" description="" onDismiss={() => {}} />
        <Toast variant="info" title="Two" description="" onDismiss={() => {}} />
      </>,
    )

    expect(screen.getAllByRole('button')).toEqual([
      screen.getByRole('button', { name: 'Dismiss "One"' }),
      screen.getByRole('button', { name: 'Dismiss "Two"' }),
    ])
  })

  it('has no action button unless given one', () => {
    render(
      <Toast
        variant="info"
        title="Reminder"
        description="You're up next on Court 3."
        onDismiss={() => {}}
      />,
    )

    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('calls the action, then onDismiss, when its action is clicked', async () => {
    const user = userEvent.setup()
    const calls: string[] = []
    render(
      <Toast
        variant="info"
        title="A new version of FortyMM is ready"
        description="Reload to get the latest update."
        action={{ label: 'Reload', onClick: () => calls.push('action') }}
        onDismiss={() => calls.push('dismiss')}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Reload' }))

    expect(calls).toEqual(['action', 'dismiss'])
  })

  it('hides its close icon from assistive tech', () => {
    render(
      <Toast variant="info" title="Reminder" description="" onDismiss={() => {}} />,
    )

    const close = screen.getByRole('button', { name: 'Dismiss "Reminder"' })
    expect(close.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('img')).toBeNull()
  })

  // Each variant's look is only CSS (checked against the reference kit in
  // the Playwright suite), so its class is the only contract jsdom can see.
  it.each([
    ['info', 'toast--info'],
    ['success', 'toast--success'],
    ['error', 'toast--error'],
  ] as const)('takes the %s variant class', (variant, className) => {
    render(
      <Toast variant={variant} title="Title" description="" onDismiss={() => {}} />,
    )

    expect(screen.getByRole('status')).toHaveClass(`toast ${className}`, {
      exact: true,
    })
  })
})
