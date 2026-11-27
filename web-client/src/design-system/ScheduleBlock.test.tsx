import { render, screen } from '@testing-library/react'
import { describe, expect, vi } from 'vitest'
import { it } from '../setupTests.ts'
import { ScheduleBlock } from './ScheduleBlock.tsx'

const description = 'Chen, Wei vs Ali, Rashid · Table 1 · 12:00–12:35'

describe('ScheduleBlock', () => {
  it('is a button read as its status and description', () => {
    render(
      <ScheduleBlock
        state="conflict"
        names={['Chen', 'Ali']}
        time="12:00–12:35"
        description={description}
      />,
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(
      /^Needs decision ?Chen, Wei vs Ali, Rashid · Table 1 · 12:00–12:35$/,
    )
  })

  it('says when it is selected', () => {
    render(<ScheduleBlock state="upcoming" time="12:00–12:35" description={description} isSelected />)
    expect(screen.getByRole('button', { pressed: true })).toBeInTheDocument()
  })

  it('selects itself when pressed', async ({ user }) => {
    const onSelectedChange = vi.fn()
    render(
      <ScheduleBlock
        state="upcoming"
        time="12:00–12:35"
        description={description}
        onSelectedChange={onSelectedChange}
      />,
    )
    await user.click(screen.getByRole('button'))
    expect(onSelectedChange).toHaveBeenCalledWith(true)
  })

  it('shows the score of a final', () => {
    render(<ScheduleBlock state="final" score="3–1" time="10:30–11:05" description={description} />)
    expect(screen.getByText(/Final/)).toHaveTextContent('Final 3–1')
  })

  it('says who is resting before an upcoming match', () => {
    render(
      <ScheduleBlock
        state="upcoming"
        rest={{ player: 'Lindqvist', until: '12:10' }}
        time="12:15–12:50"
        description={description}
      />,
    )
    expect(screen.getByText(/rests to/)).toHaveTextContent('Lindqvist rests to 12:10')
  })

  it('is no button when free', () => {
    render(<ScheduleBlock state="free" time="11:05–11:45" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
