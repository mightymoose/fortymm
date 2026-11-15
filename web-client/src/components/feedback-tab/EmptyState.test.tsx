import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Button } from '../Button.tsx'
import { EmptyState } from './EmptyState.tsx'

test('an empty state says what is missing, what to do, and offers the action', () => {
  render(
    <EmptyState
      title="No matches yet."
      action={
        <Button variant="secondary" size="sm">
          Log a match
        </Button>
      }
    >
      Log one after you play.
    </EmptyState>,
  )

  expect(screen.getByText('No matches yet.')).toBeVisible()
  expect(screen.getByText('Log one after you play.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Log a match' })).toBeVisible()
})
