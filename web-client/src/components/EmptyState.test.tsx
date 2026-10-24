import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('says what is happening, what happens next, and offers its action', () => {
    render(
      <EmptyState title="No matches on Table 5 yet" action={<button type="button">Assign a match</button>}>
        It opens for Round of 16 at about 12:30.
      </EmptyState>,
    )

    expect(screen.getByText('No matches on Table 5 yet')).toBeVisible()
    expect(screen.getByText('It opens for Round of 16 at about 12:30.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Assign a match' })).toBeVisible()
  })
})
