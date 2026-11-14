import { render } from '@testing-library/react'
import { expect, test } from 'vitest'
import { RatingChange } from './RatingChange.tsx'

test('a rise reads with a plus sign, under an up arrow', () => {
  const { container } = render(<RatingChange change={12} />)

  expect(container).toHaveTextContent('▲ +12')
})

test('a fall reads with a true minus sign, under a down arrow', () => {
  const { container } = render(<RatingChange change={-8} />)

  expect(container).toHaveTextContent('▼ −8')
})

test('the arrow is decoration: only the signed number is read', () => {
  const { container } = render(<RatingChange change={-8} />)

  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
    '▼',
  )
})
