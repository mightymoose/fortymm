import { render } from '@testing-library/react'
import { expect, test } from 'vitest'
import { RestMarker } from './RestMarker.tsx'

test('the rest marker reads as its words and time, its clock hidden', () => {
  const { container } = render(<RestMarker until="19:35" />)

  expect(container).toHaveTextContent('Rest until 19:35')
  expect(container.querySelector('svg')?.closest('[aria-hidden]')).not.toBeNull()
})
