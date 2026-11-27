import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScrollArea } from './ScrollArea.tsx'

describe('ScrollArea', () => {
  it('is a region named by its label', () => {
    render(
      <ScrollArea label="Players" maxHeight={236}>
        Nguyen, Thanh
      </ScrollArea>,
    )
    expect(screen.getByRole('region', { name: 'Players' })).toBeInTheDocument()
  })

  it('is in the tab order', () => {
    render(
      <ScrollArea label="Players" maxHeight={236}>
        Nguyen, Thanh
      </ScrollArea>,
    )
    expect(screen.getByRole('region', { name: 'Players' })).toHaveAttribute('tabindex', '0')
  })
})
