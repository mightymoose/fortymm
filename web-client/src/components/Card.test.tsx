import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Card } from './Card'

describe('Card', () => {
  it('is a region named by its title, with its subtitle, status, body and actions', () => {
    render(
      <Card
        title="Your next match"
        subtitle="Open singles · Round of 16"
        status={<span>12:05</span>}
        actions={<button type="button">I'm at the table</button>}
      >
        <p>Opponent: Park, Ji-ho</p>
      </Card>,
    )

    const card = screen.getByRole('region', { name: 'Your next match' })
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent('Your next match')
    expect(card).toHaveTextContent(
      "Your next matchOpen singles · Round of 1612:05Opponent: Park, Ji-hoI'm at the table",
    )
    expect(within(card).getByRole('button', { name: "I'm at the table" })).toBeVisible()
  })

  it('has no footer without actions', () => {
    const { container } = render(
      <Card title="Check-in">
        <p>12 of 16 players here</p>
      </Card>,
    )

    expect(container.querySelector('.fm-card__foot')).not.toBeInTheDocument()
    expect(container.querySelector('.fm-card__sub')).not.toBeInTheDocument()
  })
})
