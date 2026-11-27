import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusMarker } from './StatusMarker.tsx'

describe('StatusMarker', () => {
  it('reads its status', () => {
    render(<StatusMarker tone="conflict">Needs decision</StatusMarker>)
    expect(screen.getByText('Needs decision')).toBeInTheDocument()
  })
})
