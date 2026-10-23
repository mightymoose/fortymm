import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Badge } from './Badge'

describe('Badge', () => {
  it('shows its text', () => {
    render(<Badge>Seed 1</Badge>)

    expect(screen.getByText('Seed 1')).toBeVisible()
  })

  // Each variant's look is only CSS (checked against the reference kit in
  // the Playwright suite), so its class is the only contract jsdom can see.
  it.each([
    ['default', 'badge--default'],
    ['secondary', 'badge--secondary'],
    ['outline', 'badge--outline'],
    ['destructive', 'badge--destructive'],
    ['live', 'badge--live'],
  ] as const)('takes the %s variant class', (variant, className) => {
    render(<Badge variant={variant}>Text</Badge>)

    expect(screen.getByText('Text')).toHaveClass(`badge ${className}`, {
      exact: true,
    })
  })

  it('is the default variant unless given one', () => {
    render(<Badge>Seed 1</Badge>)

    expect(screen.getByText('Seed 1')).toHaveClass('badge', 'badge--default')
  })

  it('shows a pulsing live dot before the text of a live badge', () => {
    const { container } = render(<Badge variant="live">Live · Court 3</Badge>)

    const badge = container.querySelector('.badge')!
    const dot = badge.firstElementChild
    expect(dot).toHaveClass('ball-dot', 'ball-dot--live')
    expect(badge).toHaveTextContent(/^Live · Court 3$/)
  })

  // The dot only shows that the match is live, which the text says already.
  it('hides the live dot from assistive tech', () => {
    const { container } = render(<Badge variant="live">Live</Badge>)

    expect(container.querySelector('.ball-dot')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
  })

  it.each(['default', 'secondary', 'outline', 'destructive'] as const)(
    'shows no dot in a %s badge',
    (variant) => {
      const { container } = render(<Badge variant={variant}>Text</Badge>)

      expect(container.querySelector('.ball-dot')).not.toBeInTheDocument()
      expect(container.querySelector('.badge')!.childElementCount).toBe(0)
    },
  )
})
