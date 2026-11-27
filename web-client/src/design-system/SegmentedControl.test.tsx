import { render, screen } from '@testing-library/react'
import { describe, expect, vi } from 'vitest'
import { it } from '../setupTests.ts'
import { SegmentedControl } from './SegmentedControl.tsx'

const views = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'list', label: 'List' },
]

describe('SegmentedControl', () => {
  it('is a radio group named by its label', () => {
    render(<SegmentedControl aria-label="Schedule view" options={views} defaultSelectedId="timeline" />)
    expect(screen.getByRole('radiogroup', { name: 'Schedule view' })).toBeInTheDocument()
  })

  it('starts on its default option', () => {
    render(<SegmentedControl aria-label="Schedule view" options={views} defaultSelectedId="timeline" />)
    expect(screen.getByRole('radio', { name: 'Timeline' })).toBeChecked()
  })

  it('switches to the option clicked', async ({ user }) => {
    const onChange = vi.fn()
    render(
      <SegmentedControl
        aria-label="Schedule view"
        options={views}
        defaultSelectedId="timeline"
        onChange={onChange}
      />,
    )
    await user.click(screen.getByRole('radio', { name: 'List' }))
    expect(onChange).toHaveBeenCalledWith('list')
  })

  it('keeps one option on when the selected one is clicked again', async ({ user }) => {
    render(<SegmentedControl aria-label="Schedule view" options={views} defaultSelectedId="timeline" />)
    await user.click(screen.getByRole('radio', { name: 'Timeline' }))
    expect(screen.getByRole('radio', { name: 'Timeline' })).toBeChecked()
  })
})
