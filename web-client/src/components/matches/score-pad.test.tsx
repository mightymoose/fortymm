import { fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  buildScorePadMe,
  buildScorePadOpp,
} from './score-pad.factory'
import { scorePadPage } from './score-pad.page'

describe('ScorePad', () => {
  it('renders both sides labelled by participant name', () => {
    scorePadPage.render({
      me: buildScorePadMe({ name: 'rita.kovac', value: '11' }),
      opp: buildScorePadOpp({ name: 'nguyen.t', value: '7' }),
    })

    expect(scorePadPage.getInput('rita.kovac')).toHaveValue('11')
    expect(scorePadPage.getInput('nguyen.t')).toHaveValue('7')
  })

  it('reports each keystroke to the side onChange', () => {
    const onChange = vi.fn()
    scorePadPage.render({ me: buildScorePadMe({ onChange }) })

    fireEvent.change(scorePadPage.getInput('rita.kovac'), {
      target: { value: '9' },
    })

    expect(onChange).toHaveBeenCalledWith('9')
  })

  it('flags an invalid side with aria-invalid', () => {
    scorePadPage.render({
      me: buildScorePadMe({ value: '11.5', invalid: true }),
    })

    expect(scorePadPage.getInput('rita.kovac')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
  })

  it('shows the score error line when given one', () => {
    scorePadPage.render({ scoreError: 'A game cannot end in a tie.' })

    const alerts = scorePadPage.queryAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent('A game cannot end in a tie.')
  })

  it('shows the both-required hint on its own line', () => {
    scorePadPage.render({ showBothRequired: true })

    const alerts = scorePadPage.queryAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent('Enter both scores to save this game.')
  })

  it('hides the games tally when null (single-game matches)', () => {
    scorePadPage.render({ gamesTally: null })

    expect(scorePadPage.queryGamesTally()).toBeNull()
  })

  it('renders the games tally when provided', () => {
    scorePadPage.render({ gamesTally: '2 – 1' })

    expect(scorePadPage.queryGamesTally()).toHaveTextContent('2 – 1')
  })

  it('fires onSubmit from the primary button', () => {
    const onSubmit = vi.fn()
    scorePadPage.render({
      submitLabel: 'Save game & next →',
      canSubmit: true,
      onSubmit,
    })

    fireEvent.click(scorePadPage.getSubmit('Save game & next →'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('disables submit when it cannot submit', () => {
    scorePadPage.render({ submitLabel: 'Save', canSubmit: false })

    expect(scorePadPage.getSubmit('Save')).toBeDisabled()
  })

  it('locks the inputs and submit while a submit is in flight', () => {
    scorePadPage.render({
      submitLabel: 'Posting result…',
      canSubmit: true,
      inputsLocked: true,
    })

    expect(scorePadPage.getInput('rita.kovac')).toBeDisabled()
    expect(scorePadPage.getSubmit('Posting result…')).toBeDisabled()
  })

  it('omits the Clear action unless onClear is supplied', () => {
    scorePadPage.render({ onClear: undefined })

    expect(scorePadPage.queryClear()).toBeNull()
  })

  it('fires onClear from the Clear action when supplied', () => {
    const onClear = vi.fn()
    scorePadPage.render({ onClear })

    const clear = scorePadPage.queryClear()
    expect(clear).not.toBeNull()
    fireEvent.click(clear as HTMLElement)

    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
