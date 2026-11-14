import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Meter } from './Meter.tsx'

test('a meter is an image named by what it measures, in words', () => {
  render(<Meter value={62} label="62% of matches played" />)

  expect(
    screen.getByRole('img', { name: '62% of matches played' }),
  ).toBeVisible()
})
