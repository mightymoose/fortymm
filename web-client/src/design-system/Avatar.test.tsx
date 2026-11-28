import { render, screen } from '@testing-library/react'
import { describe, expect } from 'vitest'
import { it } from '../setupTests.ts'
import { Avatar } from './Avatar.tsx'

describe('Avatar', () => {
  it('is an image named by who it is', () => {
    render(<Avatar initials="AM" name="agile-meerkat-4b8z" />)
    expect(screen.getByRole('img', { name: 'agile-meerkat-4b8z' })).toBeInTheDocument()
  })

  it('shows the initials', () => {
    render(<Avatar initials="AM" name="agile-meerkat-4b8z" />)
    expect(screen.getByRole('img')).toHaveTextContent('AM')
  })
})
