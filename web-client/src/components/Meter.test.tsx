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
})
