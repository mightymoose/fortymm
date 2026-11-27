import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TextArea } from './TextArea.tsx'

describe('TextArea', () => {
  it('is a multi-line text box', () => {
    render(<TextArea label="Note for players" />)
    expect(screen.getByRole('textbox', { name: 'Note for players' })).toHaveProperty(
      'tagName',
      'TEXTAREA',
    )
  })

  it('is described by its help', () => {
    render(<TextArea label="Note for players" description="Shown on the entry page." />)
    expect(screen.getByRole('textbox', { name: 'Note for players' })).toHaveAccessibleDescription(
      'Shown on the entry page.',
    )
  })

  it('shows its default value', () => {
    render(<TextArea label="Note for players" defaultValue="Warm-up from 9:00." />)
    expect(screen.getByRole('textbox', { name: 'Note for players' })).toHaveValue(
      'Warm-up from 9:00.',
    )
  })
})
