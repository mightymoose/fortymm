import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Icon } from './Icon.tsx'

describe('Icon', () => {
  it('is an image named by its label', () => {
    render(<Icon name="clock" label="Clock" />)
    expect(screen.getByRole('img', { name: 'Clock' })).toBeInTheDocument()
  })

  it('is hidden without a label', () => {
    render(<Icon name="clock" />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
