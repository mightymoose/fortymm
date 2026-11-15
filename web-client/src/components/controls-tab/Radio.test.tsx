import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { Radio } from './Radio.tsx'

test('choosing a radio selects it and clears the one chosen before in its group', async () => {
  const user = userEvent.setup()
  render(
    <>
      <Radio name="format" defaultChecked>
        Best of 3
      </Radio>
      <Radio name="format">Best of 5</Radio>
    </>,
  )

  await user.click(screen.getByText('Best of 5'))

  expect(screen.getByRole('radio', { name: 'Best of 5' })).toBeChecked()
  expect(screen.getByRole('radio', { name: 'Best of 3' })).not.toBeChecked()
})

test('a disabled radio cannot be chosen', async () => {
  const user = userEvent.setup()
  render(
    <Radio name="format" disabled>
      Timed
    </Radio>,
  )

  await user.click(screen.getByText('Timed'))

  expect(screen.getByRole('radio', { name: 'Timed' })).not.toBeChecked()
})
