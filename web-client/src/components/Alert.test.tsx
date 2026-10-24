import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Alert } from './Alert'

describe('Alert', () => {
  it('is an alert named by its title, over its description', () => {
    render(
      <Alert title="Heads up" headingLevel={4}>
        The next round starts in 12 minutes.
      </Alert>,
    )

    const alert = screen.getByRole('alert', { name: 'Heads up' })
    expect(alert).toHaveTextContent(
      'Heads upThe next round starts in 12 minutes.',
    )
    expect(screen.getByRole('paragraph')).toHaveTextContent(
      'The next round starts in 12 minutes.',
    )
  })

  it.each([2, 3, 4, 5, 6] as const)(
    'shows its title as a heading at level %i',
    (level) => {
      render(
        <Alert title="Heads up" headingLevel={level}>
          Text
        </Alert>,
      )

      expect(screen.getByRole('heading', { level })).toHaveTextContent(
        'Heads up',
      )
    },
  )

  it('hides its icon from assistive tech', () => {
    render(
      <Alert title="Heads up" headingLevel={4}>
        Text
      </Alert>,
    )

    const icon = screen.getByRole('alert').querySelector('svg')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('img')).toBeNull()
  })

  // Each variant's look is only CSS (checked against the reference kit in
  // the Playwright suite), so its class is the only contract jsdom can see.
  it.each([
    ['default', 'alert--default'],
    ['warn', 'alert--warn'],
    ['destructive', 'alert--destructive'],
    ['success', 'alert--success'],
  ] as const)('takes the %s variant class', (variant, className) => {
    render(
      <Alert variant={variant} title="Title" headingLevel={4}>
        Text
      </Alert>,
    )

    expect(screen.getByRole('alert')).toHaveClass(`alert ${className}`, {
      exact: true,
    })
  })

  it('is the default variant unless given one', () => {
    render(
      <Alert title="Title" headingLevel={4}>
        Text
      </Alert>,
    )

    expect(screen.getByRole('alert')).toHaveClass('alert', 'alert--default')
  })
})
