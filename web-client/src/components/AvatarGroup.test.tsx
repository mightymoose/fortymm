import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Avatar } from './Avatar'
import { AvatarGroup } from './AvatarGroup'

describe('AvatarGroup', () => {
  it('is a group named by its label, holding its avatars in order', () => {
    render(
      <AvatarGroup label="Players">
        <Avatar name="Tien Nguyen" />
        <Avatar name="Daniel Okafor" />
      </AvatarGroup>,
    )

    const group = screen.getByRole('group', { name: 'Players' })
    expect(
      within(group)
        .getAllByRole('img')
        .map((avatar) => avatar.getAttribute('aria-label')),
    ).toEqual(['Tien Nguyen', 'Daniel Okafor'])
  })

  it('ends with a neutral circle for the overflow, named by its count', () => {
    render(
      <AvatarGroup label="Players" overflow={12}>
        <Avatar name="Tien Nguyen" />
      </AvatarGroup>,
    )

    const avatars = within(screen.getByRole('group')).getAllByRole('img')
    const circle = avatars[avatars.length - 1]
    expect(circle).toHaveAccessibleName('12 more')
    expect(circle).toHaveTextContent(/^\+12$/)
    expect(circle).toHaveClass('avatar avatar--md avatar--neutral', {
      exact: true,
    })
  })

  it('hides the overflow text from assistive tech', () => {
    render(
      <AvatarGroup label="Players" overflow={12}>
        <Avatar name="Tien Nguyen" />
      </AvatarGroup>,
    )

    expect(screen.getByText('+12')).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows no overflow circle without a count', () => {
    render(
      <AvatarGroup label="Players">
        <Avatar name="Tien Nguyen" />
      </AvatarGroup>,
    )

    expect(within(screen.getByRole('group')).getAllByRole('img')).toHaveLength(
      1,
    )
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument()
  })

  it("gives its avatars and the overflow circle the group's size", () => {
    render(
      <AvatarGroup label="Players" size="sm" overflow={3}>
        <Avatar name="Tien Nguyen" />
        <Avatar name="Daniel Okafor" />
      </AvatarGroup>,
    )

    for (const avatar of within(screen.getByRole('group')).getAllByRole(
      'img',
    )) {
      expect(avatar).toHaveClass('avatar--sm')
    }
  })

  it('lets an avatar keep its own size', () => {
    render(
      <AvatarGroup label="Players" size="sm">
        <Avatar name="Tien Nguyen" size="lg" />
      </AvatarGroup>,
    )

    expect(screen.getByRole('img')).toHaveClass('avatar--lg')
  })

  it('is medium unless given a size', () => {
    render(
      <AvatarGroup label="Players" overflow={1}>
        <Avatar name="Tien Nguyen" />
      </AvatarGroup>,
    )

    for (const avatar of within(screen.getByRole('group')).getAllByRole(
      'img',
    )) {
      expect(avatar).toHaveClass('avatar--md')
    }
  })
})
