import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Alert } from './Alert.tsx'
import { Button } from './Button.tsx'

test('an error is an alert, announced with its title, its reason and its fix', () => {
  render(
    <Alert
      tone="error"
      title="Table 4's tablet stopped sending scores"
      actions={
        <Button variant="secondary" size="sm">
          Enter score here
        </Button>
      }
    >
      The last update was at 11:42.
    </Alert>,
  )

  const alert = screen.getByRole('alert')
  expect(alert).toHaveTextContent("Table 4's tablet stopped sending scores")
  expect(alert).toHaveTextContent('The last update was at 11:42.')
  expect(screen.getByRole('button', { name: 'Enter score here' })).toBeVisible()
})

test('a warning waits in the page: it is not announced as an alert', () => {
  render(
    <Alert tone="warning" title="Okafor's singles is 15 min over">
      His doubles would start without the rest.
    </Alert>,
  )

  expect(screen.getByText("Okafor's singles is 15 min over")).toBeVisible()
  expect(screen.queryByRole('alert')).toBeNull()
})
