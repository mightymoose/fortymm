import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Alert } from './Alert.tsx'

describe('Alert', () => {
  it('announces an error', () => {
    render(
      <Alert tone="error" title="Results didn't sync">
        You're offline.
      </Alert>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent("Results didn't sync")
  })

  it('does not interrupt with a warning', () => {
    render(
      <Alert tone="warning" title="Patel would get 5 minutes’ rest">
        Her match is running over.
      </Alert>,
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('is a group named by its label', () => {
    render(
      <Alert tone="warning" label="Scheduling conflict" title="Patel would get 5 minutes’ rest">
        Her match is running over.
      </Alert>,
    )
    expect(screen.getByRole('group', { name: 'Scheduling conflict' })).toBeInTheDocument()
  })
})
