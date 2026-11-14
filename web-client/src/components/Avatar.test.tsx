import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Avatar } from './Avatar.tsx'

test('an avatar is decoration beside the name: hidden from assistive technology', () => {
  render(<Avatar initials="TN" />)

  expect(screen.getByText('TN')).toHaveAttribute('aria-hidden', 'true')
})
