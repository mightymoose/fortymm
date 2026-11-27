import { render, screen } from '@testing-library/react'
import { describe, expect } from 'vitest'
import { it } from '../setupTests.ts'
import { Radio } from './Radio.tsx'
import { RadioGroup } from './RadioGroup.tsx'

function MatchLength() {
  return (
    <RadioGroup label="Match length" defaultValue="5">
      <Radio value="3">Best of 3</Radio>
      <Radio value="5">Best of 5</Radio>
      <Radio value="timed" isDisabled>
        Timed
      </Radio>
    </RadioGroup>
  )
}

describe('RadioGroup', () => {
  it('is named by its legend', () => {
    render(<MatchLength />)
    expect(screen.getByRole('radiogroup', { name: 'Match length' })).toBeInTheDocument()
  })

  it('starts on its default value', () => {
    render(<MatchLength />)
    expect(screen.getByRole('radio', { name: 'Best of 5' })).toBeChecked()
  })

  it('checks the radio that is clicked', async ({ user }) => {
    render(<MatchLength />)
    await user.click(screen.getByRole('radio', { name: 'Best of 3' }))
    expect(screen.getByRole('radio', { name: 'Best of 3' })).toBeChecked()
  })

  it('unchecks the others when one is clicked', async ({ user }) => {
    render(<MatchLength />)
    await user.click(screen.getByRole('radio', { name: 'Best of 3' }))
    expect(screen.getByRole('radio', { name: 'Best of 5' })).not.toBeChecked()
  })

  it('disables a disabled radio', () => {
    render(<MatchLength />)
    expect(screen.getByRole('radio', { name: 'Timed' })).toBeDisabled()
  })
})
