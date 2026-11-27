import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LiveMarker } from './LiveMarker.tsx'

describe('LiveMarker', () => {
  it('reads Live', () => {
    render(<LiveMarker />)
    expect(screen.getByText('Live', { exact: true })).toBeInTheDocument()
  })
})
