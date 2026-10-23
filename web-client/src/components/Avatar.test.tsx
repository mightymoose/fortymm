import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Avatar } from './Avatar'

describe('Avatar', () => {
  it.each([
    ['Tien Nguyen', 'TN'],
    ['daniel okafor', 'DO'],
    ['Marta Anna Kowalski', 'MK'],
    ['Tien', 'T'],
    ['  Tien   Nguyen  ', 'TN'],
  ])('shows the initials of %j as %s', (name, initials) => {
    const { container } = render(<Avatar name={name} />)

    expect(container.querySelector('.avatar')).toHaveTextContent(
      new RegExp(`^${initials}$`),
    )
  })

  it('names the person by their full name', () => {
    render(<Avatar name="Tien Nguyen" />)

    expect(screen.getByRole('img', { name: 'Tien Nguyen' })).toBeVisible()
  })

  it('hides the initials from assistive tech', () => {
    render(<Avatar name="Tien Nguyen" />)

    const avatar = screen.getByRole('img')
    expect(avatar).toHaveAccessibleName('Tien Nguyen')
    expect(screen.getByText('TN')).toHaveAttribute('aria-hidden', 'true')
  })

  // Each size's and tone's look is only CSS (checked against the reference
  // kit in the Playwright suite), so its class is the only contract jsdom
  // can see.
  it.each([
    ['sm', 'avatar--sm'],
    ['md', 'avatar--md'],
    ['lg', 'avatar--lg'],
  ] as const)('takes the %s size class', (size, className) => {
    render(<Avatar name="Tien Nguyen" size={size} />)

    expect(screen.getByRole('img')).toHaveClass(
      `avatar ${className} avatar--neutral`,
      { exact: true },
    )
  })

  it.each([
    ['neutral', 'avatar--neutral'],
    ['brand', 'avatar--brand'],
    ['blue', 'avatar--blue'],
    ['red', 'avatar--red'],
    ['green', 'avatar--green'],
  ] as const)('takes the %s tone class', (tone, className) => {
    render(<Avatar name="Tien Nguyen" tone={tone} />)

    expect(screen.getByRole('img')).toHaveClass(
      `avatar avatar--md ${className}`,
      { exact: true },
    )
  })

  it('is medium and neutral unless given a size and a tone', () => {
    render(<Avatar name="Tien Nguyen" />)

    expect(screen.getByRole('img')).toHaveClass(
      'avatar avatar--md avatar--neutral',
      { exact: true },
    )
  })
})
