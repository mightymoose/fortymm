import { fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { scorePadSidePage } from './score-pad-side.page'

describe('ScorePadSide', () => {
  it('labels the input by the participant name and shows the value', () => {
    scorePadSidePage.render({ name: 'rita.kovac', value: '11' })

    expect(scorePadSidePage.getInput('rita.kovac')).toHaveValue('11')
    expect(scorePadSidePage.getName('rita.kovac')).toBeInTheDocument()
  })

  it('reports typed input through onChange', () => {
    const onChange = vi.fn()
    scorePadSidePage.render({ onChange })

    fireEvent.change(scorePadSidePage.getInput('rita.kovac'), {
      target: { value: '7' },
    })

    expect(onChange).toHaveBeenCalledWith('7')
  })

  it('sets aria-invalid when invalid', () => {
    scorePadSidePage.render({ invalid: true })

    expect(scorePadSidePage.getInput('rita.kovac')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
  })

  it('does not set aria-invalid when valid', () => {
    scorePadSidePage.render({ invalid: false })

    expect(scorePadSidePage.getInput('rita.kovac')).not.toHaveAttribute(
      'aria-invalid',
    )
  })

  it('disables the input when disabled', () => {
    scorePadSidePage.render({ disabled: true })

    expect(scorePadSidePage.getInput('rita.kovac')).toBeDisabled()
  })
})
