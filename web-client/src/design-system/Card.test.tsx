import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Card } from './Card.tsx'

describe('Card', () => {
  it('is a region named by its title', () => {
    render(<Card title="Your next match">Park, Ji-ho</Card>)
    expect(screen.getByRole('region', { name: 'Your next match' })).toBeInTheDocument()
  })
})
