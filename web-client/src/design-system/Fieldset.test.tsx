import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Checkbox } from './Checkbox.tsx'
import { Fieldset } from './Fieldset.tsx'

describe('Fieldset', () => {
  it('is a group named by its legend', () => {
    render(
      <Fieldset legend="Before the match">
        <Checkbox>Checked in</Checkbox>
      </Fieldset>,
    )
    expect(screen.getByRole('group', { name: 'Before the match' })).toBeInTheDocument()
  })
})
