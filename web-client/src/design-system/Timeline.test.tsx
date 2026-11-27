import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Timeline } from './Timeline.tsx'
import { TimelineTrack } from './TimelineTrack.tsx'

function renderTimeline() {
  render(
    <Timeline
      label="Schedule, 10:30 to 13:00"
      length={150}
      marks={[{ at: 0, label: '10:30' }]}
      now={{ at: 77, label: 'Now 11:47' }}
    >
      <TimelineTrack name="Table 1">Chen vs Ali</TimelineTrack>
    </Timeline>,
  )
}

describe('Timeline', () => {
  it('is a group named by its label', () => {
    renderTimeline()
    expect(screen.getByRole('group', { name: 'Schedule, 10:30 to 13:00' })).toBeInTheDocument()
  })

  it('has a group for each table', () => {
    renderTimeline()
    expect(screen.getByRole('group', { name: 'Table 1' })).toHaveTextContent('Chen vs Ali')
  })
})
