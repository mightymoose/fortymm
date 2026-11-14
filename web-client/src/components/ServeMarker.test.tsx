import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { ServeMarker } from './ServeMarker.tsx'

test('the serve marker, a dot with no word, is an image named Serving', () => {
  render(<ServeMarker />)

  expect(screen.getByRole('img', { name: 'Serving' })).toBeInTheDocument()
})
