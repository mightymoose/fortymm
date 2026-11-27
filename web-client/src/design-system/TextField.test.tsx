import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TextField } from './TextField.tsx'

describe('TextField', () => {
  it('is named by its label', () => {
    render(<TextField label="Player name" />)
    expect(screen.getByRole('textbox', { name: 'Player name' })).toBeInTheDocument()
  })

  it('says it is optional in its name', () => {
    render(<TextField label="Club" isOptional />)
    expect(screen.getByRole('textbox', { name: 'Club (optional)' })).toBeInTheDocument()
  })

  it('is described by its help', () => {
    render(<TextField label="Player name" description="Surname first." />)
    expect(screen.getByRole('textbox', { name: 'Player name' })).toHaveAccessibleDescription(
      'Surname first.',
    )
  })

  it('is described by its error when invalid', () => {
    render(
      <TextField
        label="Table"
        description="The table number."
        errorMessage="Enter 1–6."
        isInvalid
      />,
    )
    expect(screen.getByRole('textbox', { name: 'Table' })).toHaveAccessibleDescription('Enter 1–6.')
  })

  it('does not show its error when valid', () => {
    render(<TextField label="Table" errorMessage="Enter 1–6." />)
    expect(screen.queryByText('Enter 1–6.')).not.toBeInTheDocument()
  })

  it('is marked invalid when invalid', () => {
    render(<TextField label="Table" errorMessage="Enter 1–6." isInvalid />)
    expect(screen.getByRole('textbox', { name: 'Table' })).toBeInvalid()
  })

  it('is disabled when disabled', () => {
    render(<TextField label="Entry fee" isDisabled />)
    expect(screen.getByRole('textbox', { name: 'Entry fee' })).toBeDisabled()
  })

  it('asks for a number keypad when numeric', () => {
    render(<TextField label="Table" isNumeric />)
    expect(screen.getByRole('textbox', { name: 'Table' })).toHaveAttribute('inputmode', 'numeric')
  })

  it('shows its default value', () => {
    render(<TextField label="Table" defaultValue="9" />)
    expect(screen.getByRole('textbox', { name: 'Table' })).toHaveValue('9')
  })
})
