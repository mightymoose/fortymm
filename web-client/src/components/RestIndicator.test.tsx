import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RestIndicator } from './RestIndicator'

describe('RestIndicator', () => {
  it('says when the rest ends', () => {
    render(<RestIndicator until="12:10" />)

    expect(screen.getByText(/Rest until/)).toHaveTextContent('Rest until 12:10')
  })
})
