import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RestMarker } from './RestMarker.tsx'

describe('RestMarker', () => {
  it('reads when the rest ends', () => {
    render(<RestMarker until="12:10" />)
    expect(screen.getByText(/Rest until/)).toHaveTextContent('Rest until 12:10')
  })
})
