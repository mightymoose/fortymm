import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Meter } from './Meter'

describe('Meter', () => {
  it('is a progress bar named by its label, with its value and maximum', () => {
    render(<Meter label="Rest elapsed" value={7} max={15} rest />)

    const meter = screen.getByRole('progressbar', { name: 'Rest elapsed' })
    expect(meter).toHaveAttribute('aria-valuenow', '7')
    expect(meter).toHaveAttribute('aria-valuemax', '15')
  })

  it('fills exactly value of max', () => {
    render(<Meter label="Round of 16 progress" value={5} max={8} />)

    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement
    expect(fill.style.width).toBe('62.5%')
  })

  it('fills to the percent it is given', () => {
    render(<Meter label="Rest elapsed" value={7} max={15} percent={47} rest />)

    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement
    expect(fill.style.width).toBe('47%')
  })
})
