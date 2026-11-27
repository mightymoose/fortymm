import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, vi } from 'vitest'
import { it } from '../setupTests.ts'
import { CodeInput } from './CodeInput.tsx'

function box(n: number) {
  return screen.getByRole('textbox', { name: `Character ${n} of 6` })
}

describe('CodeInput', () => {
  it('is a group named by its label', () => {
    render(<CodeInput label="Tournament code" />)
    expect(screen.getByRole('group', { name: 'Tournament code' })).toBeInTheDocument()
  })

  it('has one box per character', () => {
    render(<CodeInput label="Tournament code" />)
    expect(screen.getAllByRole('textbox')).toHaveLength(6)
  })

  it('spreads its default value across the boxes', () => {
    render(<CodeInput label="Tournament code" defaultValue="SP26RV" />)
    expect(box(4)).toHaveValue('6')
  })

  it('shows letters in capitals', async ({ user }) => {
    render(<CodeInput label="Tournament code" />)
    await user.type(box(1), 's')
    expect(box(1)).toHaveValue('S')
  })

  it('drops anything but letters and numbers', async ({ user }) => {
    render(<CodeInput label="Tournament code" />)
    await user.type(box(1), '-')
    expect(box(1)).toHaveValue('')
  })

  it('moves to the next box after a character', async ({ user }) => {
    render(<CodeInput label="Tournament code" />)
    await user.type(box(1), 'S')
    expect(box(2)).toHaveFocus()
  })

  it('reports the whole code as it is typed', async ({ user }) => {
    const onChange = vi.fn()
    render(<CodeInput label="Tournament code" onChange={onChange} />)
    await user.type(box(1), 'SP2')
    expect(onChange).toHaveBeenLastCalledWith('SP2')
  })

  it('spreads a pasted code across the boxes', () => {
    render(<CodeInput label="Tournament code" />)
    fireEvent.change(box(1), { target: { value: 'sp-26rv' } })
    expect(box(6)).toHaveValue('V')
  })

  it('replaces a filled box with the character typed into it', async ({ user }) => {
    render(<CodeInput label="Tournament code" defaultValue="SP26RV" />)
    await user.click(box(6))
    await user.keyboard('X')
    expect(box(6)).toHaveValue('X')
  })

  it('goes back a box on Backspace in an empty box', async ({ user }) => {
    render(<CodeInput label="Tournament code" defaultValue="SP" />)
    await user.click(box(3))
    await user.keyboard('{Backspace}')
    expect(box(2)).toHaveFocus()
  })

  it('is described by its error when invalid', () => {
    render(<CodeInput label="Tournament code" isInvalid errorMessage="No tournament uses that code." />)
    expect(screen.getByRole('group', { name: 'Tournament code' })).toHaveAccessibleDescription(
      'No tournament uses that code.',
    )
  })

  it('marks its boxes invalid when invalid', () => {
    render(<CodeInput label="Tournament code" isInvalid errorMessage="No tournament uses that code." />)
    expect(box(1)).toBeInvalid()
  })

  it('is described by its help', () => {
    render(<CodeInput label="Tournament code" description="Entries have closed." />)
    expect(screen.getByRole('group', { name: 'Tournament code' })).toHaveAccessibleDescription(
      'Entries have closed.',
    )
  })

  it('disables its boxes when disabled', () => {
    render(<CodeInput label="Tournament code" isDisabled />)
    expect(box(1)).toBeDisabled()
  })
})
