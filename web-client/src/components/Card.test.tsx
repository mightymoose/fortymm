import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'
import { Card } from './Card'

describe('Card', () => {
  it('renders an article named by its title, at the given heading level', () => {
    render(
      <Card
        headingLevel={4}
        title="April Spring Open"
        description="Hosted by Brooklyn TT Club"
      >
        32 players, single-elimination.
      </Card>,
    )

    const card = screen.getByRole('article', { name: 'April Spring Open' })
    expect(
      within(card).getByRole('heading', { level: 4, name: 'April Spring Open' }),
    ).toBeInTheDocument()
    expect(within(card).getByText('Hosted by Brooklyn TT Club')).toBeVisible()
    expect(within(card).getByText('32 players, single-elimination.')).toBeVisible()
  })

  it.each([2, 3, 5, 6] as const)('renders its title as an h%i', (level) => {
    render(
      <Card headingLevel={level} title="Results">
        Body
      </Card>,
    )

    expect(
      screen.getByRole('heading', { level, name: 'Results' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('heading')).toHaveLength(1)
  })

  it('shows its title, description and body in that order', () => {
    render(
      <Card headingLevel={3} title="Title" description="Description">
        Body
      </Card>,
    )

    expect(screen.getByRole('article')).toHaveTextContent(
      /^TitleDescriptionBody$/,
    )
  })

  it('has no description or footer unless given one', () => {
    render(
      <Card headingLevel={3} title="Title">
        Body
      </Card>,
    )

    const card = screen.getByRole('article', { name: 'Title' })
    expect(card).toHaveTextContent(/^TitleBody$/)
    expect(within(card).queryByRole('paragraph')).not.toBeInTheDocument()
    expect(within(card).queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows its footer after the body', () => {
    render(
      <Card
        headingLevel={3}
        title="Title"
        footer={
          <>
            <Button size="sm">Register</Button>
            <Button size="sm" variant="outline">
              View draw
            </Button>
          </>
        }
      >
        Body
      </Card>,
    )

    const card = screen.getByRole('article', { name: 'Title' })
    expect(within(card).getByRole('button', { name: 'Register' })).toBeVisible()
    expect(within(card).getByRole('button', { name: 'View draw' })).toBeVisible()
    expect(card).toHaveTextContent(/^TitleBodyRegisterView draw$/)
  })

  it('names each card by its own title', () => {
    render(
      <>
        <Card headingLevel={3} title="First">
          One
        </Card>
        <Card headingLevel={3} title="Second">
          Two
        </Card>
      </>,
    )

    expect(screen.getByRole('article', { name: 'First' })).toHaveTextContent(
      'One',
    )
    expect(screen.getByRole('article', { name: 'Second' })).toHaveTextContent(
      'Two',
    )
  })

  // The featured look is only CSS (border, glow and title colour, checked
  // against the reference kit in the Playwright suite), so its class is the
  // only contract jsdom can see.
  it('takes the featured class only for the featured variant', () => {
    render(
      <>
        <Card headingLevel={3} title="Plain">
          One
        </Card>
        <Card headingLevel={3} title="Featured" variant="featured">
          Two
        </Card>
      </>,
    )

    expect(screen.getByRole('article', { name: 'Plain' })).not.toHaveClass(
      'card--featured',
    )
    expect(screen.getByRole('article', { name: 'Featured' })).toHaveClass(
      'card',
      'card--featured',
    )
  })
})
