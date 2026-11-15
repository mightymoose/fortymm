import { render } from '@testing-library/react'
import { expect, test } from 'vitest'
import { StatusMarker } from './StatusMarker.tsx'

// A status says itself in words; its icon is decoration.
test('a status marker reads as its words, its mark hidden', () => {
  const { container } = render(
    <StatusMarker status="conflict">Needs decision</StatusMarker>,
  )

  expect(container).toHaveTextContent('Needs decision')
  expect(container.querySelector('svg')?.closest('[aria-hidden]')).not.toBeNull()
})
