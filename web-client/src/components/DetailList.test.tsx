import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DetailList } from './DetailList'

describe('DetailList', () => {
  it('lists each label with its value, numbers in the number font', () => {
    render(
      <DetailList
        details={[
          { term: 'Rating', value: '2,088', numeric: true },
          { term: 'Today', value: 'Won 2, lost 0' },
        ]}
      />,
    )

    expect(screen.getAllByRole('term').map((term) => term.textContent)).toEqual([
      'Rating',
      'Today',
    ])
    const [rating, today] = screen.getAllByRole('definition')
    expect(rating).toHaveTextContent('2,088')
    expect(rating).toHaveClass('num')
    expect(today).toHaveTextContent('Won 2, lost 0')
    expect(today).not.toHaveClass('num')
  })
})
