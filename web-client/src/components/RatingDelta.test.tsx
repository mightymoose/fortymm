import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RatingDelta } from './RatingDelta'

describe('RatingDelta', () => {
  it('shows a gain with a plus sign, as a gain', () => {
    render(<RatingDelta value={18} />)

    expect(screen.getByText('+18')).toHaveClass('rating-delta--gain', {
      exact: true,
    })
  })

  it('shows a loss with a minus sign, not a hyphen, as a loss', () => {
    render(<RatingDelta value={-4} />)

    expect(screen.getByText('−4')).toHaveClass('rating-delta--loss', {
      exact: true,
    })
  })

  it('shows no change unsigned, as neither', () => {
    render(<RatingDelta value={0} />)

    expect(screen.getByText('0')).not.toHaveAttribute('class')
  })
})
