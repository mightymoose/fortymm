import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Accordion } from './Accordion'

const items = [
  { value: 'scheduler', title: 'Scheduler', content: 'How it schedules.' },
  { value: 'free', title: 'Free', content: 'What it costs.' },
  { value: 'ratings', title: 'Ratings', content: 'How ratings move.' },
]

function trigger(name: string) {
  return screen.getByRole('button', { name })
}

function expanded() {
  return screen
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-expanded'))
}

describe('Accordion', () => {
  it('heads each item with a button at the given level', () => {
    render(<Accordion items={items} headingLevel={4} />)

    const headings = screen.getAllByRole('heading', { level: 4 })
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'Scheduler⌄',
      'Free⌄',
      'Ratings⌄',
    ])
    for (const [index, heading] of headings.entries()) {
      const button = trigger(items[index].title)
      expect(heading).toContainElement(button)
      expect(button).toHaveAttribute('type', 'button')
      expect(button).toHaveClass('accordion-trigger')
    }
  })

  it('names each button by its title alone, without the chevron', () => {
    render(<Accordion items={items} headingLevel={4} />)

    expect(trigger('Scheduler')).toHaveAccessibleName('Scheduler')
  })

  it('opens only the items it is told to', () => {
    render(
      <Accordion items={items} defaultOpen={['scheduler']} headingLevel={4} />,
    )

    expect(expanded()).toEqual(['true', 'false', 'false'])
    const region = screen.getByRole('region')
    expect(region).toHaveTextContent('How it schedules.')
    expect(region).toHaveAccessibleName('Scheduler')
    expect(trigger('Scheduler')).toHaveAttribute('aria-controls', region.id)
    expect(screen.getByText('What it costs.')).not.toBeVisible()
  })

  it('starts closed unless told otherwise', () => {
    render(<Accordion items={items} headingLevel={4} />)

    expect(expanded()).toEqual(['false', 'false', 'false'])
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })

  it('opens and closes each item on its own', async () => {
    const user = userEvent.setup()
    render(
      <Accordion items={items} defaultOpen={['scheduler']} headingLevel={4} />,
    )

    await user.click(trigger('Ratings'))
    expect(expanded()).toEqual(['true', 'false', 'true'])
    expect(screen.getByText('How ratings move.')).toBeVisible()

    await user.click(trigger('Scheduler'))
    expect(expanded()).toEqual(['false', 'false', 'true'])
    expect(screen.getByText('How it schedules.')).not.toBeVisible()
  })

  it('toggles an item with Enter and Space', async () => {
    const user = userEvent.setup()
    render(<Accordion items={items} headingLevel={4} />)
    await user.tab()

    await user.keyboard('{Enter}')
    expect(expanded()).toEqual(['true', 'false', 'false'])
    await user.keyboard(' ')
    expect(expanded()).toEqual(['false', 'false', 'false'])
  })
})
