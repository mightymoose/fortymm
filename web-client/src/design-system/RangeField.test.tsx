import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RangeField } from './RangeField.tsx'

function MinimumRest() {
  return (
    <RangeField
      label="Minimum rest between matches"
      min={5}
      max={30}
      step={5}
      defaultValue={15}
      formatValue={(minutes) => `${minutes} min`}
    />
  )
}

// jsdom can't drag a range input, so these set its value with a change event.
describe('RangeField', () => {
  it('is named by its label alone', () => {
    render(<MinimumRest />)
    expect(screen.getByRole('slider', { name: 'Minimum rest between matches' })).toBeInTheDocument()
  })

  it('reads out its formatted value', () => {
    render(<MinimumRest />)
    expect(screen.getByRole('slider', { name: 'Minimum rest between matches' })).toHaveAttribute(
      'aria-valuetext',
      '15 min',
    )
  })

  it('shows its new value after the label when changed', () => {
    render(<MinimumRest />)
    fireEvent.change(screen.getByRole('slider', { name: 'Minimum rest between matches' }), {
      target: { value: '20' },
    })
    expect(screen.getByRole('status')).toHaveTextContent('20 min')
  })
})
