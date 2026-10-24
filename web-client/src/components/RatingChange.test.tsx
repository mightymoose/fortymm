import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RatingChange } from './RatingChange'

describe('RatingChange', () => {
  it('signs a gain with a plus and an up arrow', () => {
    render(<RatingChange change={12} />)

    expect(screen.getByText('▲ +12')).toHaveClass('rating-up')
  })

  it('signs a loss with a minus sign and a down arrow', () => {
    render(<RatingChange change={-12} />)

    expect(screen.getByText('▼ −12')).toHaveClass('rating-down')
  })

  it('shows no change as 0', () => {
    render(<RatingChange change={0} />)

    expect(screen.getByText('0')).not.toHaveClass('rating-up', 'rating-down')
  })
})
