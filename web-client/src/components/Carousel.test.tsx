import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Carousel } from './Carousel'

const cards = ['Final A', 'Final B', 'Final C', 'Final D', 'Final E']

function renderCarousel() {
  render(
    <Carousel
      title="Finished"
      previousLabel="Previous results"
      nextLabel="Next results"
      trackLabel="Finished matches"
      items={cards}
      slides={(card, slide) => (
        <article {...slide}>
          <p>{card}</p>
        </article>
      )}
    />,
  )
  return screen.getByLabelText('Finished matches')
}

// jsdom lays nothing out, so this gives the track the gallery's layout at
// the suite's width: 926px wide, cards 250px wide 16px apart, and a
// scrollTo that scrolls at once.
function layOut(track: HTMLElement) {
  const define = (element: Element, key: string, value: unknown) =>
    Object.defineProperty(element, key, { configurable: true, value, writable: true })
  define(track, 'clientWidth', 926)
  define(track, 'scrollWidth', 5 * 250 + 4 * 16)
  define(track, 'scrollLeft', 0)
  ;[...track.children].forEach((slide, index) => {
    define(slide, 'offsetLeft', index * 266)
    define(slide, 'offsetWidth', 250)
  })
  define(track, 'scrollTo', ({ left }: ScrollToOptions) => {
    track.scrollLeft = Math.min(left!, track.scrollWidth - track.clientWidth)
    fireEvent.scroll(track)
  })
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
}

const position = () => screen.getByText(/of 5$/)
const button = (name: string) => screen.getByRole('button', { name })

describe('Carousel', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is a carousel named by its title, with each card a slide of five', () => {
    renderCarousel()

    expect(screen.getByRole('region', { name: 'Finished' })).toHaveAttribute(
      'aria-roledescription',
      'carousel',
    )
    expect(screen.getByRole('group', { name: '2 of 5' })).toHaveTextContent('Final B')
    expect(screen.getByRole('group', { name: '2 of 5' })).toHaveAttribute(
      'aria-roledescription',
      'slide',
    )
  })

  it('shows which cards are in view, and starts with Previous off', () => {
    layOut(renderCarousel())

    expect(position()).toHaveTextContent('1–3 of 5')
    expect(button('Previous results')).toBeDisabled()
    expect(button('Next results')).toBeEnabled()
  })

  it('steps one card on and back with its buttons', async () => {
    const user = userEvent.setup()
    layOut(renderCarousel())

    await user.click(button('Next results'))
    expect(await screen.findByText('2–4 of 5')).toBeInTheDocument()
    expect(button('Previous results')).toBeEnabled()

    await user.click(button('Next results'))
    await vi.waitFor(() => expect(button('Next results')).toBeDisabled())

    await user.click(button('Previous results'))
    expect(await screen.findByText('1–3 of 5')).toBeInTheDocument()
    expect(button('Previous results')).toBeDisabled()
  })

  it('never moves on its own', async () => {
    layOut(renderCarousel())

    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(position()).toHaveTextContent('1–3 of 5')
  })
})
