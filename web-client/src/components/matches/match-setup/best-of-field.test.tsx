import { userEvent } from '@testing-library/user-event'

import { bestOfFieldPage } from './best-of-field.page'

describe('BestOfField', () => {
  it('marks the current best-of as checked', () => {
    bestOfFieldPage.render({ bestOf: 3 })

    expect(bestOfFieldPage.getOption(3)).toHaveAttribute('aria-checked', 'true')
    expect(bestOfFieldPage.getOption(5)).toHaveAttribute('aria-checked', 'false')
  })

  it('describes a single game distinctly from a best-of series', () => {
    bestOfFieldPage.render({ bestOf: 1 })
    expect(
      bestOfFieldPage.getHelp('One game, winner takes all.'),
    ).toBeInTheDocument()

    bestOfFieldPage.render({ bestOf: 7 })
    expect(bestOfFieldPage.getHelp('First to 4 games.')).toBeInTheDocument()
  })

  it('picks an option on click', async () => {
    const setBestOf = vi.fn()
    bestOfFieldPage.render({ bestOf: 5, setBestOf })

    await userEvent.click(bestOfFieldPage.getOption(7))

    expect(setBestOf).toHaveBeenCalledWith(7)
  })

  it('moves the roving tab stop with ArrowRight and selects the next option', async () => {
    const setBestOf = vi.fn()
    bestOfFieldPage.render({ bestOf: 5, setBestOf })

    bestOfFieldPage.getOption(5).focus()
    await userEvent.keyboard('{ArrowRight}')

    expect(setBestOf).toHaveBeenCalledWith(7)
    expect(bestOfFieldPage.getOption(7)).toHaveFocus()
  })

  it('wraps from the last option to the first with ArrowRight', async () => {
    const setBestOf = vi.fn()
    bestOfFieldPage.render({ bestOf: 7, setBestOf })

    bestOfFieldPage.getOption(7).focus()
    await userEvent.keyboard('{ArrowRight}')

    expect(setBestOf).toHaveBeenCalledWith(1)
  })

  it('only tabs to the currently checked option', () => {
    bestOfFieldPage.render({ bestOf: 3 })

    expect(bestOfFieldPage.getOption(3)).toHaveAttribute('tabIndex', '0')
    expect(bestOfFieldPage.getOption(1)).toHaveAttribute('tabIndex', '-1')
  })
})
