import { render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Card } from './Card.tsx'

test('a card is an article titled by a heading at the level it is given', () => {
  render(
    <Card title="Nguyen, Thanh vs Okafor, Daniel" headingLevel={4}>
      <p>Table 3</p>
    </Card>,
  )

  const card = screen.getByRole('article')
  expect(
    within(card).getByRole('heading', {
      level: 4,
      name: 'Nguyen, Thanh vs Okafor, Daniel',
    }),
  ).toBeVisible()
})
