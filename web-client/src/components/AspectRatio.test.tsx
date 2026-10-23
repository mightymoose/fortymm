import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AspectRatio } from './AspectRatio'

// The box's height comes from its ratio, which only a real browser lays out,
// so the Playwright suite checks it against the reference kit.
describe('AspectRatio', () => {
  it('shows its content', () => {
    render(<AspectRatio ratio={16 / 9}>16 : 9</AspectRatio>)

    expect(screen.getByText('16 : 9')).toBeVisible()
  })
})
